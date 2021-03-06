// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');
const mkdirp = require('mkdirp');
const rimraf = require('rimraf');
const Plugin = require('broccoli-plugin');
const walkSync = require('walk-sync');
const mapSeries = require('promise-map-series');
const symlinkOrCopySync = require('symlink-or-copy').sync;
const debugGenerator = require('heimdalljs-logger');
const md5Hex = require('./lib/md5-hex');
const Processor = require('./lib/processor');
const Dependencies = require('./lib/dependencies'); // jshint ignore:line
const addPatches = require('./lib/addPatches');
const hashForDep = require('hash-for-dep');
const FSTree = require('fs-tree-diff');
const heimdall = require('heimdalljs');
const queue = require('async-promise-queue');

class ApplyPatchesSchema {
  constructor() {
    this.mkdir = 0;
    this.rmdir = 0;
    this.unlink = 0;
    this.change = 0;
    this.create = 0;
    this.other = 0;
    this.processed = 0;
    this.linked = 0;
    this.handleFile = 0;

    this.processString = 0;
    this.processStringTime = 0;
    this.persistentCacheHit = 0;
    this.persistentCachePrime = 0;
    this.handleFileTime = 0;
  }
}

class DerivePatchesSchema {
  constructor() {
    this.patches = 0;
    this.entries = 0;
  }
}

const worker = queue.async.asyncify(doWork => doWork());

function nanosecondsSince(time) {
  let delta = process.hrtime(time);
  return delta[0] * 1e9 + delta[1];
}

function timeSince(time) {
  let deltaNS = nanosecondsSince(time);
  return (deltaNS / 1e6).toFixed(2) +' ms';
}

/**
 * @param invalidated {Array<string>} The files that have been invalidated.
 * @param currentTree {FSTree} the current tree - for entry lookup.
 * @param nextTree {FSTree} The next tree - for entry lookup.
 */
function invalidationsAsPatches(invalidated, currentTree, nextTree) {
  if (invalidated.length === 0) {
    return [];
  }
  /** @type {Array<FSTree.Operation>} */
  let patches = [];
  let currentEntries = {};
  for (let entry of currentTree.entries) {
    currentEntries[entry.relativePath] = entry;
  }
  let nextEntries = {};
  for (let entry of nextTree.entries) {
    nextEntries[entry.relativePath] = entry;
  }
  for (let file of invalidated) {
    if (currentEntries[file]) {
      patches.push(['change', file, currentEntries[file]]);
    } else if (nextEntries[file]) {
      patches.push(['create', file, nextEntries[file]]);
    }
  }
  return patches;
}

async function invoke(context, fn, args) {
  return await fn.apply(context, args);
}

module.exports = class Filter extends Plugin {
  static shouldPersist(env, persist) {
    let result;

    if (env.CI) {
      result = persist && env.FORCE_PERSISTENCE_IN_CI;
    } else {
      result = persist;
    }

    return !!result;
  }

  constructor(inputTree, options) {
    super([inputTree], {
      name: (options && options.name),
      annotation: (options && options.annotation),
      persistentOutput: true
    });

    if (Object.getPrototypeOf(this) === Filter.prototype) {
      throw new TypeError('[BroccoliPersistentFilter] BroccoliPersistentFilter Is an abstract class, and cannot be instantiated directly, rather is intended to be sub-classed');
    }

    let loggerName = 'broccoli-persistent-filter:' + (this.constructor.name);
    let annotation = (options && options.annotation);
    if (annotation) {
      loggerName += ' > [' + annotation + ']';
    }

    /** @type {{debug(...s: any[]): void; info(...s: any[]): void}} */
    // @ts-ignore
    this._logger = debugGenerator(loggerName);

    /** @type {Processor} */
    this.processor = new Processor(options);
    /** @type {Dependencies | null} */
    this.dependencies = null;

    this.currentTree = new FSTree();

    /* Destructuring assignment in node 0.12.2 would be really handy for this! */
    if (options) {
      if (options.extensions != null)      this.extensions = options.extensions;
      if (options.targetExtension != null) this.targetExtension = options.targetExtension;
      if (options.inputEncoding != null)   this.inputEncoding = options.inputEncoding;
      if (options.outputEncoding != null)  this.outputEncoding = options.outputEncoding;
      if (Filter.shouldPersist(process.env, options.persist)) {
        this.processor.setStrategy(require('./lib/strategies/persistent'));
      }
      this.async = (options.async === true);
    }

    this.processor.init(this);

    // TODO: don't enable this by default. it's just for testing.
    /** @type {boolean} */
    this.dependencyInvalidation = options && options.dependencyInvalidation || false;
    this._canProcessCache = Object.create(null);
    this._destFilePathCache = Object.create(null);
    this._needsReset = false;

    this.concurrency = (options && options.concurrency) || Number(process.env.JOBS) || Math.max(require('os').cpus().length - 1, 1);
    this._outputLinks = Object.create(null);
  }

  async build() {
    // @ts-ignore
    let srcDir = this.inputPaths[0];
    // @ts-ignore
    let destDir = this.outputPath;

    if (this.dependencyInvalidation && !this.dependencies) {
      this.dependencies = this.processor.initialDependencies(srcDir);
    }

    if (this._needsReset) {
      this.currentTree = new FSTree();
      // @ts-ignore
      let instrumentation = heimdall.start('reset');
      if (this.dependencies) {
        this.dependencies = this.processor.initialDependencies(srcDir);
      }
      // @ts-ignore
      rimraf.sync(this.outputPath);
      // @ts-ignore
      mkdirp.sync(this.outputPath);
      instrumentation.stop();
    }

    let prevTime = process.hrtime();
    // @ts-ignore
    let instrumentation = heimdall.start('derivePatches', DerivePatchesSchema);

    let walkStart = process.hrtime();
    let entries = walkSync.entries(srcDir);
    let nextTree = FSTree.fromEntries(entries);
    let walkDuration = timeSince(walkStart);

    let invalidationsStart = process.hrtime();
    let invalidated = this.dependencies && this.dependencies.getInvalidatedFiles() || [];
    this._logger.info('found', invalidated.length, 'files invalidated due to dependency changes.');
    let invalidationPatches = invalidationsAsPatches(invalidated, this.currentTree, nextTree);
    let invalidationsDuration = timeSince(invalidationsStart);

    let patches = this.currentTree.calculatePatch(nextTree);
    patches = addPatches(invalidationPatches, patches);

    instrumentation.stats.patches = patches.length;
    instrumentation.stats.entries = entries.length;
    instrumentation.stats.invalidations = {
      dependencies: this.dependencies ? this.dependencies.countUnique() : 0,
      count: invalidationPatches.length,
      duration: invalidationsDuration
    };
    instrumentation.stats.walk = {
      entries: entries.length,
      duration: walkDuration
    };

    this.currentTree = nextTree;

    this._logger.info('derivePatches', 'duration:', timeSince(prevTime), JSON.stringify(instrumentation.stats));

    instrumentation.stop();

    if (this.dependencies && patches.length > 0) {
      let files = patches.filter(p => p[0] === 'unlink').map(p => p[1]);
      this.dependencies = this.dependencies.copyWithout(files);
    }

    if (patches.length === 0) {
      // no work, exit early
      return;
    } else {
      // do actual work, that may fail
      this._needsReset = true;
    }

    // used with options.async = true to allow 'create' and 'change' operations to complete async
    const pendingWork = [];
    // @ts-ignore
    return heimdall.node('applyPatches', ApplyPatchesSchema, async instrumentation => {
      let prevTime = process.hrtime();
      await mapSeries(patches, patch => {
        let operation = patch[0];
        let relativePath = patch[1];
        let entry = patch[2];
        let outputPath = destDir + '/' + (this.getDestFilePath(relativePath, entry) || relativePath);
        let outputFilePath = outputPath;
        let forceInvalidation = invalidated.includes(relativePath);

        this._logger.debug('[operation:%s] %s', operation, relativePath);

        switch (operation) {
          case 'mkdir': {
            instrumentation.mkdir++;
            return fs.mkdirSync(outputPath);
          } case 'rmdir': {
            instrumentation.rmdir++;
            return fs.rmdirSync(outputPath);
          } case 'unlink': {
            instrumentation.unlink++;
            return fs.unlinkSync(outputPath);
          } case 'change': {
            // wrap this in a function so it doesn't actually run yet, and can be throttled
            let changeOperation = () => {
              instrumentation.change++;
              return this._handleFile(relativePath, srcDir, destDir, entry, outputFilePath, forceInvalidation, true, instrumentation);
            };
            if (this.async) {
              pendingWork.push(changeOperation);
              return;
            }
            return changeOperation();
          } case 'create': {
            // wrap this in a function so it doesn't actually run yet, and can be throttled
            let createOperation = () => {
              instrumentation.create++;
              return this._handleFile(relativePath, srcDir, destDir, entry, outputFilePath, forceInvalidation, false, instrumentation);
            };
            if (this.async) {
              pendingWork.push(createOperation);
              return;
            }
            return createOperation();
          } default: {
            instrumentation.other++;
          }
        }
      });
      const result = await queue(worker, pendingWork, this.concurrency);
      this._logger.info('applyPatches', 'duration:', timeSince(prevTime), JSON.stringify(instrumentation));
      if (this.dependencies) {
        this.processor.sealDependencies(this.dependencies);
      }
      this._needsReset = false;
      return result;
    });
  }

  async _handleFile(relativePath, srcDir, destDir, entry, outputPath, forceInvalidation, isChange, stats) {
    stats.handleFile++;

    let handleFileStart = process.hrtime();
    try {
      let result;
      let srcPath = srcDir + '/' + relativePath;

      if (this.canProcessFile(relativePath, entry)) {
        stats.processed++;
        if (this._outputLinks[outputPath] === true) {
          delete this._outputLinks[outputPath];
          fs.unlinkSync(outputPath);
        }
        result = await this.processAndCacheFile(srcDir, destDir, entry, forceInvalidation, isChange, stats);
      } else {
        stats.linked++;
        if (isChange) {
          fs.unlinkSync(outputPath);
        }
        result = symlinkOrCopySync(srcPath, outputPath);
        this._outputLinks[outputPath] = true;
      }
      return result;
    } finally {
      stats.handleFileTime += nanosecondsSince(handleFileStart);
    }
  }

  /*
 The cache key to be used for this plugins set of dependencies. By default
 a hash is created based on `package.json` and nested dependencies.

 Implement this to customize the cache key (for example if you need to
 account for non-NPM dependencies).

 @public
 @method cacheKey
 @returns {String}
 */
  cacheKey() {
    return hashForDep(this.baseDir());
  }

/* @public
 *
 * @method baseDir
 * @returns {String} absolute path to the root of the filter...
 */
  baseDir() {
    throw Error('[BroccoliPersistentFilter] Filter must implement prototype.baseDir');
  }

  /**
   * @public
   *
   * optionally override this to build a more rhobust cache key
   * @param  {String} string The contents of a file that is being processed
   * @return {String}        A cache key
   */
  cacheKeyProcessString(string, relativePath) {
    return md5Hex(string + 0x00 + relativePath);
  }

  canProcessFile(relativePath, entry) {
    return !!this.getDestFilePath(relativePath, entry);
  }

  isDirectory(relativePath, entry) {
    // @ts-ignore
    if (this.inputPaths === undefined) {
      return false;
    }

    // @ts-ignore
    let srcDir = this.inputPaths[0];
    let path = srcDir + '/' + relativePath;

    return (entry || fs.lstatSync(path)).isDirectory();
  }

  getDestFilePath(relativePath, entry) {
    // NOTE: relativePath may have been moved or unlinked
    if (this.isDirectory(relativePath, entry)) {
      return null;
    }

    if (this.extensions == null) {
      return relativePath;
    }

    for (let i = 0, ii = this.extensions.length; i < ii; ++i) {
      let ext = this.extensions[i];
      if (relativePath.slice(-ext.length - 1) === '.' + ext) {
        if (this.targetExtension != null) {
          relativePath = relativePath.slice(0, -ext.length) + this.targetExtension;
        }
        return relativePath;
      }
    }

    return null;
  }

  async processAndCacheFile(srcDir, destDir, entry, forceInvalidation, isChange, instrumentation) {
    let filter = this;
    let relativePath = entry.relativePath;
    try {
      return await filter.processFile(srcDir, destDir, relativePath, forceInvalidation, isChange, instrumentation, entry);
    } catch (e) {
      let error = e;
      if (typeof e !== 'object') error = new Error('' + e);
      error.file = relativePath;
      error.treeDir = srcDir;
      throw error;
    }
  }

  async processFile(srcDir, destDir, relativePath, forceInvalidation, isChange, instrumentation, entry) {
    let filter = this;
    let inputEncoding = this.inputEncoding;
    let outputEncoding = this.outputEncoding;

    if (inputEncoding === undefined)  inputEncoding  = 'utf8';
    if (outputEncoding === undefined) outputEncoding = 'utf8';

    let contents = fs.readFileSync(srcDir + '/' + relativePath, {
      encoding: inputEncoding
    });

    instrumentation.processString++;
    let processStringStart = process.hrtime();
    let outputString = await invoke(this.processor, this.processor.processString, [this, contents, relativePath, forceInvalidation, instrumentation]);
    instrumentation.processStringTime += nanosecondsSince(processStringStart);
    let outputPath = filter.getDestFilePath(relativePath, entry);

    if (outputPath == null) {
      throw new Error('[BroccoliPersistentFilter] canProcessFile("' + relativePath +
                      '") is true, but getDestFilePath("' +
                      relativePath + '") is null');
    }

    outputPath = destDir + '/' + outputPath;

    if (isChange) {
      let isSame = fs.readFileSync(outputPath, 'UTF-8') === outputString;
      if (isSame) {
        this._logger.debug('[change:%s] but was the same, skipping', relativePath, isSame);
        return;
      } else {
        this._logger.debug('[change:%s] but was NOT the same, writing new file', relativePath);
      }
    }

    try {
      fs.writeFileSync(outputPath, outputString, {
        encoding: outputEncoding
      });

    } catch (e) {
      if (e !== null && typeof e === 'object' && e.code === 'ENOENT') {
        mkdirp.sync(path.dirname(outputPath));
        fs.writeFileSync(outputPath, outputString, {
          encoding: outputEncoding
        });
      } else {
        // unexpected error, simply re-throw;
        throw e;
      }
    }

    return outputString;
  }

  /**
   * @param contents {string}
   * @param relativePath {string}
   * @returns {string}
   */
  processString(contents, relativePath) { // jshint ignore:line
    throw new Error(
        '[BroccoliPersistentFilter] When subclassing broccoli-persistent-filter you must implement the ' +
        '`processString()` method.');
  }

  postProcess(result /*, relativePath */) {
    return result;
  }
};
