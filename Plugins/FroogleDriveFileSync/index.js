//Authour: Dustin Harris
//GitHub: https://github.com/DevL0rd
const chokidar = require('chokidar');
var watchers = {};
var watcher
const fs = require('fs');
const mkdirp = require('mkdirp');
const DB = require('../../Devlord_modules/DB.js');
const md5 = require('md5');
var startTime = new Date().getTime();
var endTime = new Date().getTime();
var workerIo;
var log;
var io;
var settingsPath = __dirname + "/settings.json";
if (fs.existsSync(settingsPath)) {
    var settings = DB.load(settingsPath);
} else {
    var settings = {
        trash: {
            trashPath: "./Trash"
        },
        syncDirectory: { "path": "./FroogalDrive" },
        fileWatcher: {
            persistent: true,
            ignored: ['**/*.incomplete'],
            ignoreInitial: false,
            followSymlinks: true,
            usePolling: true,
            interval: 100,
            binaryInterval: 300,
            alwaysStat: true,
            depth: 999,
            awaitWriteFinish: {
                stabilityThreshold: 2000,
                pollInterval: 100
            },
            ignorePermissionErrors: true,
            atomic: true // or a custom 'atomicity delay', in milliseconds (default 100)
        }
    }
    DB.save(settingsPath, settings);
}
settings.fileWatcher.cwd = settings.syncDirectory.path;
mkdirp(settings.syncDirectory.path, function (err) {
    if (err) {
        log(err.message + ".\n" + err.stack, true, "FroogalDriveSync");
    };
});
var fileCachePath = __dirname + "/fileCache.json"
if (fs.existsSync(fileCachePath)) {
    var fileCache = DB.load(fileCachePath);
} else {
    var fileCache = {};
    DB.save(fileCachePath, fileCache);
}
var newFileCache = {};
function init(pluginExports, sSettings, events, nIo, nLog, commands, nWorkerIo) {
    log = nLog;
    workerIo = nWorkerIo;
    io = nIo;
    events.on("connection", function (socket) {
        socket.on('ping', function () {
            socket.emit('pong');
        });
    });
    if (nWorkerIo.isWorker) {
        events.on("doJob", function (job) {
            // if (job.jobName == "addAll") {
            //     job.complete(addAll(job.data));
            // }
        });
    } else {
        //start watching directories
        var path = settings.syncDirectory.path;
        watchers[path] = chokidar.watch(path, settings.fileWatcher);
        watcher = watchers[path];
        watcher.on('add', function (path, stats) {
            log("File '" + path + "' scanned.", false, "FroogalDriveSync");
            fs.readFile(settings.syncDirectory.path + "/" + path, function (err, buf) {
                if (err) {
                    log(err.message + ".\n" + err.stack, true, "FroogalDriveSync");
                    return;
                }
                newFileCache[path] = { stats: stats, md5: md5(buf) };
                triggerWatcherReady();
            });
        });
        watcher.on('addDir', function (path, stats) {
            if (path) { //ignore root dir
                log("Directory '" + path + "' scanned.", false, "FroogalDriveSync");
                newFileCache[path] = { stats: stats };
                triggerWatcherReady();
            }
        });
        watcher.on('ready', function () {
            //not an accurate after inital scan time
            triggerWatcherReady();
        });
    }
}
var watcherReadyTimeout
function triggerWatcherReady() {
    clearTimeout(watcherReadyTimeout);
    watcherReadyTimeout = setTimeout(function () {
        console.log(getChangedFiles(newFileCache, fileCache)); //DEBUG
        fileCache = newFileCache;
        queueCacheSave();
        watcher.on('add', function (path, stats) {
            add(path, stats);
        });
        watcher.on('change', function (path, stats) {
            change(path, stats);
        });
        watcher.on('unlink', function (path) {
            unlink(path);
        });
        watcher.on('addDir', function (path, stats) {
            addDir(path, stats);
        });
        watcher.on('unlinkDir', function (path) {
            unlinkDir(path);
        });
        log('FroogalDrive file scan complete! Watching for changes...', false, "FroogalDriveSync");
    }, 1000);
}
function unlink(path) {
    log("File '" + path + "' removed. Sending update to clients.", false, "FroogalDriveSync");
    delete fileCache[path];
    io.emit('fileUnlink', { path: path });
    queueCacheSave();
}
function unlinkDir(path) {
    log("Directory '" + path + "' removed. Sending update to clients.", false, "FroogalDriveSync");
    delete fileCache[path];
    io.emit('unlinkDir', { path: path });
    queueCacheSave();
}
function addDir(path, stats) {
    log("Directory '" + path + "' added. Sending update to clients.", false, "FroogalDriveSync");
    fileCache[path] = { stats: stats };
    io.emit('addDir', { path: path, stats: stats });
    queueCacheSave();
}
function change(path, stats) {
    log("File '" + path + "' modified. Sending update to clients.", false, "FroogalDriveSync");
    fs.readFile(settings.syncDirectory.path + "/" + path, function (err, buf) {
        if (err) {
            log(err.message + ".\n" + err.stack, true, "FroogalDriveSync");
            return;
        }
        fileCache[path] = { stats: stats, md5: md5(buf) };
        io.emit('fileChange', { path: path, stats: stats, md5: md5(buf) });
        queueCacheSave();
    });
}
function add(path, stats) {
    log("File '" + path + "' added. Sending update to clients.", false, "FroogalDriveSync");
    fs.readFile(settings.syncDirectory.path + "/" + path, function (err, buf) {
        if (err) {
            log(err.message + ".\n" + err.stack, true, "FroogalDriveSync");
            return;
        }
        fileCache[path] = { stats: stats, md5: md5(buf) };
        io.emit('fileAdd', { path: path, stats: stats, md5: md5(buf) });
        queueCacheSave();
    });
}
function getChangedFiles(newFC, oldFC) {
    var fileChanges = [];
    for (i in oldFC) {
        var fcPath = i;
        var oldCachedFile = oldFC[fcPath];
        if (newFC[fcPath]) {
            if (newFC[fcPath].md5 != oldCachedFile.md5) {
                fileChanges.push({ change: "change", path: fcPath });
            }
        } else {
            if (oldCachedFile.md5) {
                fileChanges.push({ change: "unlink", path: fcPath });
            } else {
                fileChanges.push({ change: "unlinkDir", path: fcPath });
            }
        }
    }
    for (i in newFC) {
        var fcPath = i;
        var newCachedFile = newFC[fcPath];
        if (oldFC[fcPath]) {
            if (newCachedFile.md5 != newFC[fcPath].md5) {
                fileChanges.push({ change: "change", path: fcPath });
            }
        } else {
            if (newCachedFile.md5) {
                fileChanges.push({ change: "add", path: fcPath });
            } else {
                fileChanges.push({ change: "addDir", path: fcPath });
            }
        }
    }
    return sortOrderOfFileChanges(fileChanges);
}
function sortOrderOfFileChanges(fileChanges) {
    //sort by shortest folder depth first
    fileChanges.sort(function (a, b) { return (a.path.match("/\\/g") || []).length - (b.path.match("/\\/g") || []).length });
    //sort by action.
    //All remove actions go first, then modify, then add
    var sortedFileChanges = [];
    var unlinkdirs = [];
    var unlinks = [];
    var changes = [];
    var addDirs = [];
    var adds = [];
    for (i in fileChanges) {
        var fChange = fileChanges[i].change;
        if (fChange == "unlinkDir") {
            unlinkdirs.push(fileChanges[i])
        } else if (fChange == "unlink") {
            unlinks.push(fileChanges[i]);
        } else if (fChange == "change") {
            changes.push(fileChanges[i]);
        } else if (fChange == "addDir") {
            addDirs.push(fileChanges[i]);
        } else if (fChange == "add") {
            adds.push(fileChanges[i]);
        }
    }
    sortedFileChanges = sortedFileChanges.concat(unlinkdirs);
    sortedFileChanges = sortedFileChanges.concat(unlinks);
    sortedFileChanges = sortedFileChanges.concat(changes);
    sortedFileChanges = sortedFileChanges.concat(addDirs);
    sortedFileChanges = sortedFileChanges.concat(adds);
    return sortedFileChanges;
}
var cacheSaveTimeout;
function queueCacheSave() {
    clearTimeout(cacheSaveTimeout);
    cacheSaveTimeout = setTimeout(function () {
        DB.save(fileCachePath, fileCache);
        log('Changes cached.', false, "FroogalDriveSync");
    }, 500);
}
function uninit(events, io, log, commands) {
    //Leave blank and let server know this can be reloaded
}
exports.init = init;
exports.uninit = uninit;