import { join } from 'path';
import { quote } from 'shlex';
import { GlobalConfig } from '../../config/global';
import { TEMPORARY_ERROR } from '../../constants/error-messages';
import { NugetDatasource } from '../../datasource/nuget';
import { parseRegistryUrl } from '../../datasource/nuget/common';
import { logger } from '../../logger';
import { exec } from '../../util/exec';
import type { ExecOptions } from '../../util/exec/types';
import {
  ensureCacheDir,
  getSiblingFileName,
  outputFile,
  readLocalFile,
  remove,
  writeLocalFile,
} from '../../util/fs';
import * as hostRules from '../../util/host-rules';
import { regEx } from '../../util/regex';
import type {
  UpdateArtifact,
  UpdateArtifactsConfig,
  UpdateArtifactsResult,
} from '../types';
import { getDependentPackageFiles } from './package-tree';
import {
  getConfiguredRegistries,
  getDefaultRegistries,
  getRandomString,
} from './util';

async function addSourceCmds(
  packageFileName: string,
  config: UpdateArtifactsConfig,
  nugetConfigFile: string
): Promise<string[]> {
  const { localDir } = GlobalConfig.get();
  const registries =
    (await getConfiguredRegistries(packageFileName, localDir)) ||
    getDefaultRegistries();
  const result = [];
  for (const registry of registries) {
    const { username, password } = hostRules.find({
      hostType: NugetDatasource.id,
      url: registry.url,
    });
    const registryInfo = parseRegistryUrl(registry.url);
    let addSourceCmd = `dotnet nuget add source ${registryInfo.feedUrl} --configfile ${nugetConfigFile}`;
    if (registry.name) {
      // Add name for registry, if known.
      addSourceCmd += ` --name ${quote(registry.name)}`;
    }
    if (username && password) {
      // Add registry credentials from host rules, if configured.
      addSourceCmd += ` --username ${username} --password ${password} --store-password-in-clear-text`;
    }
    result.push(addSourceCmd);
  }
  return result;
}

async function runDotnetRestore(
  packageFileName: string,
  dependentPackageFileNames: string[],
  config: UpdateArtifactsConfig
): Promise<void> {
  const execOptions: ExecOptions = {
    docker: {
      image: 'dotnet',
    },
  };
  const nugetCacheDir = await ensureCacheDir('nuget');
  const nugetConfigDir = join(nugetCacheDir, `${getRandomString()}`);
  const nugetConfigFile = join(nugetConfigDir, `nuget.config`);
  await outputFile(
    nugetConfigFile,
    `<?xml version="1.0" encoding="utf-8"?>\n<configuration>\n</configuration>\n`
  );

  const cmds = [
    ...(await addSourceCmds(packageFileName, config, nugetConfigFile)),
    ...dependentPackageFileNames.map(
      (f) =>
        `dotnet restore ${f} --force-evaluate --configfile ${nugetConfigFile}`
    ),
  ];

  logger.info({ cmd: cmds }, 'dotnet command');
  await exec(cmds, execOptions);
  await remove(nugetConfigDir);
}

async function getLockFileContentMap(lockFileNames: string[]): Promise<object> {
  const lockFileContentMap = {};

  for (const lockFileName of lockFileNames) {
    lockFileContentMap[lockFileName] = await readLocalFile(
      lockFileName,
      'utf8'
    );
  }

  return lockFileContentMap;
}

export async function updateArtifacts({
  packageFileName,
  newPackageFileContent,
  config,
  updatedDeps,
}: UpdateArtifact): Promise<UpdateArtifactsResult[] | null> {
  logger.debug(`nuget.updateArtifacts(${packageFileName})`);

  if (!regEx(/(?:cs|vb|fs)proj$/i).test(packageFileName)) {
    // This could be implemented in the future if necessary.
    // It's not that easy though because the questions which
    // project file to restore how to determine which lock files
    // have been changed in such cases.
    logger.debug(
      { packageFileName },
      'Not updating lock file for non project files'
    );
    return null;
  }

  const packageFiles = (await getDependentPackageFiles(packageFileName)).concat(
    packageFileName
  );

  logger.debug(
    { packageFiles },
    `Found ${packageFiles.length} dependent package files`
  );

  const lockFileNames = packageFiles.map((f) =>
    getSiblingFileName(f, 'packages.lock.json')
  );

  logger.info(lockFileNames, 'lockFileNames');

  const existingLockFileContentMap = await getLockFileContentMap(lockFileNames);

  const hasLockFileContent = Object.keys(existingLockFileContentMap).reduce(
    (a, k) => a || existingLockFileContentMap[k],
    false
  );
  if (!hasLockFileContent) {
    logger.info(
      { packageFileName },
      'No lock file found for package or dependents'
    );
    return null;
  }

  try {
    if (updatedDeps.length === 0 && config.isLockFileMaintenance !== true) {
      logger.debug(
        `Not updating lock file because no deps changed and no lock file maintenance.`
      );
      return null;
    }

    await writeLocalFile(packageFileName, newPackageFileContent);

    await runDotnetRestore(packageFileName, packageFiles, config);

    const newLockFileContentMap = await getLockFileContentMap(lockFileNames);

    const retArray = [];
    for (const lockFileName of lockFileNames) {
      if (
        existingLockFileContentMap[lockFileName] ===
        newLockFileContentMap[lockFileName]
      ) {
        logger.debug(`Lock file ${lockFileName} is unchanged`);
      } else {
        retArray.push({
          file: {
            type: 'addition',
            path: lockFileName,
            contents: newLockFileContentMap[lockFileName],
          },
        });
      }
    }

    logger.debug('Returning updated lock files');
    return retArray.length > 0 ? retArray : null;
  } catch (err) {
    // istanbul ignore if
    if (err.message === TEMPORARY_ERROR) {
      throw err;
    }
    logger.debug({ err }, 'Failed to generate lock file');
    return [
      {
        artifactError: {
          lockFile: lockFileNames.join(', '),
          stderr: err.message,
        },
      },
    ];
  }
}
