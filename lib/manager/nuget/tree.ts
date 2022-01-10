import TreeModel from 'tree-model';
import et from 'elementtree';
import xpath from 'xpath';
import { DOMParser as xmldom } from 'xmldom';
import * as fs from 'fs-extra';
import {
  ensureCacheDir,
  findFilesByExtensionsRecursively,
  getSiblingFileName,
  outputFile,
  readLocalFile,
  relativePathToAbsolute,
  remove,
  writeLocalFile,
} from '../../util/fs';
import {
  dirname,
  resolve
} from 'path';
import normalize from 'normalize-path';

// 1. Get all project files
// 2. Normalize to full path
// 3. Iterate normally and build tree
//
//


function getAllProjectFiles(directory: string): Promise<string[]> {
  return findFilesByExtensionsRecursively(directory, ["csproj", "vbproj", "fsproj"]);
}

async function getProjectFileContentMap(files: string[]): Promise<object> {
  const contentMap = {};
  for (const fileName of files) {
    contentMap[fileName] = await fs.readFile(fileName, "utf8");
  }
  return contentMap;
}

function getAbsolutePathToFile(fromFile: string, toFile: string): string {
  return resolve(`${dirname(fromFile)}/${normalize(toFile)}`);
}

function getProjectFileDependencies(projectFilePath: string, projectFileXmlContent: string): string[] {
  const doc = new xmldom().parseFromString(projectFileXmlContent);
  const projectReferenceElements = xpath.select('.//ProjectReference', doc);
  const projectReferenceRelativePaths = projectReferenceElements.map(e => e.getAttribute('Include'));
  const projectReferenceAbsolutePaths = projectReferenceRelativePaths.map(p => getAbsolutePathToFile(projectFilePath, p));
  return projectReferenceAbsolutePaths;
}

function getProjectFileAncestors(projectFileContentMap: object, projectFile: string): string[] {
  const checkNext = [];
  for (const fileName in projectFileContentMap) {
    if (getProjectFileDependencies(fileName, projectFileContentMap[fileName]).includes(projectFile)) {
      checkNext.push(fileName);
    }
  }

  delete projectFileContentMap[projectFile];

  return [projectFile, ...checkNext.map(f => getProjectFileAncestors(projectFileContentMap, f)).flat()];
}

export async function getFilesToRestore(projectFile: string, rootProjectDirectory: string): Promise<string[]> {
  const contentMap = await getProjectFileContentMap(await getAllProjectFiles(rootProjectDirectory));
  return getProjectFileAncestors(contentMap, `${rootProjectDirectory}/${projectFile}`);
}
