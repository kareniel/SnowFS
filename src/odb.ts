import * as crypto from 'crypto';
import * as fse from 'fs-extra';

import { basename, join, relative } from 'path';
import {
  DirItem, OSWALK, osWalk, zipFile,
} from './io';

import { Repository, RepositoryInitOptions } from './repository';
import { Commit } from './commit';
import { Reference } from './reference';
import { calculateFileHash, HashBlock } from './common';
import { TreeDir, TreeFile } from './treedir';
import { IoContext } from './io_context';

const defaultConfig: any = {
  version: 2,
  filemode: false,
  symlinks: true,
};

/**
 * A class representing the internal database of a `SnowFS` repository.
 * The class offers accessibility functions to read or write from the database.
 * Some functions are useful in a variety of contexts, where others are mostly
 * used when a repository is opened or initialized.
 */
export class Odb {
  config: any;

  repo: Repository;

  constructor(repo: Repository) {
    this.repo = repo;
  }

  static async open(repo: Repository): Promise<Odb> {
    const odb: Odb = new Odb(repo);
    return fse.readFile(join(repo.commondir(), 'config')).then((buf: Buffer) => {
      odb.config = JSON.parse(buf.toString());
      if (odb.config.version === 1) {
        throw new Error(`repository version ${odb.config.version} is not supported`);
      }
      return odb;
    });
  }

  static async create(repo: Repository, options: RepositoryInitOptions): Promise<Odb> {
    const odb: Odb = new Odb(repo);
    return fse.pathExists(options.commondir)
      .then((exists: boolean) => {
        if (exists) {
          throw new Error('directory already exists');
        }
        return fse.ensureDir(options.commondir);
      })
      .then(() => fse.ensureDir(join(options.commondir, 'objects')))
      .then(() => fse.ensureDir(join(options.commondir, 'versions')))
      .then(() => fse.ensureDir(join(options.commondir, 'hooks')))
      .then(() => fse.ensureDir(join(options.commondir, 'refs')))
      .then(() => {
        odb.config = { ...defaultConfig };
        return fse.writeFile(join(options.commondir, 'config'), JSON.stringify(defaultConfig));
      })
      .then(() => odb);
  }

  async readCommits(): Promise<Commit[]> {
    const objectsDir: string = join(this.repo.options.commondir, 'versions');
    return osWalk(objectsDir, OSWALK.FILES)
      .then((value: DirItem[]) => {
        const promises: Promise<Commit>[] = [];
        for (const ref of value) {
          promises.push(fse.readFile(ref.path).then((buf: Buffer) => JSON.parse(buf.toString())));
        }
        return Promise.all(promises);
      })
      .then((commits: any) => {
        const visit = (obj: any[]|any, parent: TreeDir) => {
          if (Array.isArray(obj)) {
            return obj.map((c: any) => visit(c, parent));
          }
          if (obj.children) {
            const o: TreeDir = Object.setPrototypeOf(obj, TreeDir.prototype);
            o.children = obj.children.map((t: any) => visit(t, o));
            o.parent = parent;
            return o;
          }

          const o: TreeFile = Object.setPrototypeOf(obj, TreeFile.prototype);
          o.parent = parent;
          if (obj.hash) {
            o.hash = obj.hash;
          }
          return o;
        };

        return commits.map((commit: any) => {
          const tmpCommit = commit;

          tmpCommit.date = new Date(tmpCommit.date); // convert number from JSON into date object
          const c: Commit = Object.setPrototypeOf(tmpCommit, Commit.prototype);
          c.repo = this.repo;
          c.root = visit(c.root, null);
          return c;
        });
      });
  }

  async readReference(ref: DirItem) {
    const refPath = ref.path;
    return fse.readFile(refPath)
      .then((buf: Buffer) => {
        try {
          return { ref, content: JSON.parse(buf.toString()) };
        } catch (error) {
          console.log('Error');
          return null;
        }
      });
  }

  async readReferences(): Promise<Reference[]> {
    type DirItemAndReference = { ref: DirItem; content : any };

    const refsDir: string = join(this.repo.options.commondir, 'refs');

    return osWalk(refsDir, OSWALK.FILES)
      .then((value: DirItem[]) => {
        const promises = [];
        for (const ref of value) {
          promises.push(this.readReference(ref));
        }
        return Promise.all(promises);
      })
      .then((ret: DirItemAndReference[] | null): Reference[] => ret.filter((x) => !!x).map((ret: DirItemAndReference | null) => {
        const opts = {
          hash: ret.content.hash,
          start: ret.content.start,
          userData: ret.content.userData,
        };
        return new Reference(basename(ret.ref.path), this.repo, opts);
      }))
      .then((refsResult: Reference[]) => refsResult);
  }

  async deleteHeadReference(ref: Reference) {
    const refsDir: string = join(this.repo.options.commondir, 'refs');
    // writing a head to disk means that either the name of the ref is stored or the hash in case the HEAD is detached
    return fse.unlink(join(refsDir, ref.getName()));
  }

  async writeHeadReference(head: Reference) {
    const refsDir: string = this.repo.options.commondir;
    // writing a head to disk means that either the name of the ref is stored or the hash in case the HEAD is detached
    return fse.writeFile(join(refsDir, 'HEAD'), head.getName() === 'HEAD' ? head.hash : head.getName());
  }

  async readHeadReference(): Promise<string | null> {
    const refsDir: string = this.repo.options.commondir;
    return fse.readFile(join(refsDir, 'HEAD')).then((buf: Buffer) => buf.toString()).catch((error) => {
      console.log('No HEAD found');
      return undefined;
    });
  }

  getObjectPath(file: TreeFile): string {
    const objects: string = join(this.repo.options.commondir, 'objects');
    return join(objects, file.hash.substr(0, 2), file.hash.substr(2, 2), file.hash.toString());
  }

  async writeReference(ref: Reference): Promise<void> {
    const refsDir: string = join(this.repo.options.commondir, 'refs');

    if (ref.isDetached()) {
      console.warn('Was about to write HEAD ref to disk');
      return;
    }

    if (!ref.hash) {
      throw new Error(`hash value of ref is ${ref.hash}`);
    }

    const refPath = join(refsDir, ref.getName());

    return fse.writeFile(refPath, JSON.stringify({
      hash: ref.hash,
      start: ref.start ? ref.start : undefined,
      userData: ref.userData ?? {},
    }));
  }

  async writeCommit(commit: Commit): Promise<void> {
    const objectsDir: string = join(this.repo.options.commondir, 'versions');
    const commitSha256: string = commit.hash;
    const dstFile: string = join(objectsDir, commitSha256);

    const stream = fse.createWriteStream(dstFile, { flags: 'w' });
    const parent: string = `"${commit.parent.join('","')}"`;
    stream.write('{');
    stream.write(`"hash": "${commit.hash}",
                  "message": "${commit.message}",
                  "date": ${commit.date.getTime()},
                  "parent": [${parent}], "root":`);
    stream.write(commit.root.toString(true));
    if (commit.tags) {
      stream.write(',"tags": [');
      let seperator = ' ';
      commit.tags.forEach((tag) => {
        stream.write(`${seperator}"${tag}"`);
        seperator = ', ';
      });
      stream.write(' ]');
    }
    if (commit.userData) {
      stream.write(`,"userData": ${JSON.stringify(commit.userData)}`);
    }
    stream.write('}');

    return new Promise((resolve, reject) => {
      stream.on('finish', resolve);
      stream.on('error', reject);
      stream.end();
    });
  }

  async writeObject(filepath: string, ioContext: IoContext): Promise<{file: string, hash: string}> {
    const tmpFilename: string = crypto.createHash('sha256').update(process.hrtime().toString()).digest('hex');
    const objects: string = join(this.repo.options.commondir, 'objects');
    const tmpDir: string = join(this.repo.options.commondir, 'tmp');
    const tmpPath: string = join(tmpDir, tmpFilename.toString());

    let dstFile: string;
    let filehash: string;
    let hashBlocks: HashBlock[];

    // Important, first copy the file, then compute the hash of the cloned file.
    // In that order we prevent race conditions of file changes between the hash
    // computation and the file that ends up in the odb.

    return fse.ensureDir(tmpDir, {}).then(() => ioContext.copyFile(filepath, tmpPath)).then(() => calculateFileHash(filepath))
      .then((res: {filehash: string, hashBlocks?: HashBlock[]}) => {
        filehash = res.filehash;
        hashBlocks = res.hashBlocks;
        dstFile = join(objects, filehash.substr(0, 2), filehash.substr(2, 2), filehash.toString());
        return fse.pathExists(dstFile);
      })
      .then((exists: boolean) => {
        if (exists) {
          // if dst already exists, we don't need the source anymore
          return fse.remove(tmpPath);
        }

        if (this.repo.options.compress) {
          return zipFile(tmpPath, dstFile, { deleteSrc: true });
        }

        return fse.move(tmpPath, dstFile, { overwrite: true });
      })
      .then(() => {
        if (hashBlocks) {
          const content: string = hashBlocks.map((block: HashBlock) => `${block.start};${block.end};${block.hash};`).join('\n');
          return fse.writeFile(`${dstFile}.hblock`, content);
        }
        return Promise.resolve();
      })
      .then(() => ({ file: relative(this.repo.repoWorkDir, filepath), hash: filehash }));
  }

  async readObject(hash: string, dst: string, ioContext: IoContext): Promise<void> {
    const objectFile: string = join(this.repo.options.commondir, 'objects', hash.substr(0, 2), hash.substr(2, 2), hash.toString());

    return fse.pathExists(objectFile).then((exists: boolean) => {
      if (!exists) {
        throw new Error(`object ${hash} not found`);
      }

      return ioContext.copyFile(objectFile, dst);
    });
  }
}
