import * as upath from 'upath';
import { loadFixture } from '../../../test/util';
import { GlobalConfig } from '../../config/global';
import type { RepoGlobalConfig } from '../../config/types';
import type { ExtractConfig } from '../types';
import { extractPackageFile } from './extract';

const config: ExtractConfig = {};

const adminConfig: RepoGlobalConfig = {
  localDir: upath.resolve('lib/manager/nuget/__fixtures__'),
};

describe('manager/nuget/tree', () => {
  describe('getProjectFileContentMap()', () => {
    beforeEach(() => {
      GlobalConfig.set(adminConfig);
    });
    afterEach(() => {
      GlobalConfig.reset();
    });
    it('returns file with content in map', async () => {
      fs.readLocalFile.mockResolvedValueOnce('Current some-project-file.csproj' as any);
      fs.readLocalFile.mockResolvedValueOnce('Current some-other-project-file.csproj' as any);
      expect(await getProjectFileContentMap(
        ['some-project-file.csproj',
         'some-other-project-file.csproj']
        )).toEqual(
        {  }
      );
    });
  });
});
