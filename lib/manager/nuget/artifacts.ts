import { join } from 'path';
import et from 'elementtree';
import { quote } from 'shlex';
import { GlobalConfig } from '../../config/global';
import { TEMPORARY_ERROR } from '../../constants/error-messages';
import { id, parseRegistryUrl } from '../../datasource/nuget';
import { logger } from '../../logger';
import { exec } from '../../util/exec';
import type { ExecOptions } from '../../util/exec/types';
import {
  ensureCacheDir,
  getSiblingFileName,
  outputFile,
  readLocalFile,
  //relativePathToAbsolute,
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
      hostType: id,
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

function extractDependentProjectFiles(projectFileContent: string): string[] {
  const doc = new et.parse(projectFileContent);
  const projectReferenceElements = doc.findAll('*/ProjectReference');
  const projectReferenceRelativePaths = projectReferenceElements.map(e => e.attrib['Include']);
  return projectReferenceRelativePaths;
}

async function getDependentProjectFiles(projectFilePath: string): Promise<string[]> {
  const projectFileContent = await readLocalFile(projectFilePath, 'utf8');
  const relativeDependentPaths = extractDependentProjectFiles(projectFileContent);
  //const absoluteDependentPaths = relativeDependentPaths.map(p => path.isAbsolute(p) ? p : relativePathToAbsolute(path.dirname(projectFilePath), p));
  const pathsToUse = relativeDependentPaths;
  if (pathsToUse.length === 0) {
    return pathsToUse;
  } else {
    const recursedDependentPaths = await Promise.all(pathsToUse.map(p => getDependentProjectFiles(p)));
    return pathsToUse.concat(recursedDependentPaths.flat());
  }
}

async function runDotnetRestore(
  packageFileName: string,
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

  debugger;
  const projectsToRestore = await getDependentProjectFiles(packageFileName);

  const cmds = [
    ...(await addSourceCmds(packageFileName, config, nugetConfigFile)),
    ...projectsToRestore.map(p => `dotnet restore ${p} --force-evaluate --configfile ${nugetConfigFile}`),
  ];
  logger.info({ cmd: cmds }, 'dotnet command');
  cmds.shift();
  await exec(cmds, execOptions);
  await remove(nugetConfigDir);
}

export async function updateArtifacts({
  packageFileName,
  newPackageFileContent,
  config,
  updatedDeps,
}: UpdateArtifact): Promise<UpdateArtifactsResult[] | null> {
  logger.info(`nuget.updateArtifacts(${packageFileName})`);
  if (!regEx(/(?:cs|vb|fs)proj$/i).test(packageFileName)) {
    // This could be implemented in the future if necessary.
    // It's not that easy though because the questions which
    // project file to restore how to determine which lock files
    // have been changed in such cases.
    logger.info(
      { packageFileName },
      'Not updating lock file for non project files'
    );
    return null;
  }

  const lockFileName = getSiblingFileName(
    packageFileName,
    'packages.lock.json'
  );
  const existingLockFileContent = await readLocalFile(lockFileName, 'utf8');
  if (!existingLockFileContent) {
    logger.info(
      { packageFileName },
      'No lock file found beneath package file.'
    );
    return null;
  }

  try {
    if (updatedDeps.length === 0 && config.isLockFileMaintenance !== true) {
      logger.info(
        `Not updating lock file because no deps changed and no lock file maintenance.`
      );
      return null;
    }

    await writeLocalFile(packageFileName, newPackageFileContent);

    await runDotnetRestore(packageFileName, config);

    const newLockFileContent = await readLocalFile(lockFileName, 'utf8');
    if (existingLockFileContent === newLockFileContent) {
      logger.info(`Lock file is unchanged`);
      return null;
    }
    logger.info('Returning updated lock file');
    return [
      {
        file: {
          name: lockFileName,
          contents: await readLocalFile(lockFileName),
        },
      },
    ];
  } catch (err) {
    // istanbul ignore if
    if (err.message === TEMPORARY_ERROR) {
      throw err;
    }
    logger.info({ err }, 'Failed to generate lock file');
    return [
      {
        artifactError: {
          lockFile: lockFileName,
          stderr: err.message,
        },
      },
    ];
  }
}
