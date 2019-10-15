//Authour: Dustin Harris
//GitHub: https://github.com/DevL0rd
const chokidar = require('chokidar');
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
    if (nWorkerIo.isWorker) {
        events.on("doJob", function (job) {
            // if (job.jobName == "addAll") {
            //     job.complete(addAll(job.data));
            // }
        });
    } else {
        initWatcher(function () {
            io.emit("isReady");
            events.on("connection", function (socket) {
                socket.on('add', function () {

                });
                socket.on('addDir', function () {

                });
                socket.on('change', function () {

                });
                socket.on('unlink', function () {

                });
                socket.on('unlinkDir', function () {

                });
                socket.on('getFileCache', function () {
                    socket.emit('getFileCache', fileCache);
                });
            });
        });
    }
}
function initWatcher(doneCallback) {
    //start watching directories
    newFileCache = {};
    var path = settings.syncDirectory.path;
    watcher = chokidar.watch(path, settings.fileWatcher);
    watcher.on('add', function (path, stats) {
        log("File '" + path + "' scanned.", false, "FroogalDriveSync");
        fs.readFile(settings.syncDirectory.path + "/" + path, function (err, buf) {
            if (err) {
                log(err.message + ".\n" + err.stack, true, "FroogalDriveSync");
                return;
            }
            newFileCache[path] = { stats: stats, md5: md5(buf) };
            triggerWatcherReady(doneCallback);
        });
    });
    watcher.on('addDir', function (path, stats) {
        if (path) { //ignore root dir
            log("Directory '" + path + "' scanned.", false, "FroogalDriveSync");
            newFileCache[path] = { stats: stats };
            triggerWatcherReady(doneCallback);
        }
    });
    watcher.on('ready', function () {
        //not an accurate after inital scan time
        triggerWatcherReady(doneCallback);
    });
}
var watcherReadyTimeout
var fileUpdateQueue = [];
function triggerWatcherReady(doneCallback) {
    clearTimeout(watcherReadyTimeout);
    watcherReadyTimeout = setTimeout(function () {
        console.log(getChangedFiles(newFileCache, fileCache)); //DEBUG
        fileCache = newFileCache; //Server only
        queueCacheSave();
        settings.fileWatcher.ignoreInitial = true;
        watcher.close();
        watcher = chokidar.watch(settings.syncDirectory.path, settings.fileWatcher);
        watcher.on('add', add);
        watcher.on('change', change);
        watcher.on('unlink', unlink);
        watcher.on('addDir', addDir);
        watcher.on('unlinkDir', unlinkDir);
        watcher.on('ready', function () {
            log('FroogalDrive file scan complete! Watching for changes...', false, "FroogalDriveSync");
            doneCallback();
        });
    }, 1000);
}
function unlink(path) {
    log("File '" + path + "' removed. Sending update to clients.", false, "FroogalDriveSync");
    delete fileCache[path];
    queueCacheSave();
    queueFileUpdate({ change: "unlink", path: path });
}
function unlinkDir(path) {
    log("Directory '" + path + "' removed. Sending update to clients.", false, "FroogalDriveSync");
    delete fileCache[path];
    queueCacheSave();
    queueFileUpdate({ change: "unlinkDir", path: path });
}
function addDir(path, stats) {
    log("Directory '" + path + "' added. Sending update to clients.", false, "FroogalDriveSync");
    fileCache[path] = { stats: stats };
    queueCacheSave();
    queueFileUpdate({ change: "addDir", path: path, stats: stats });
}
function change(path, stats) {
    log("File '" + path + "' modified. Sending update to clients.", false, "FroogalDriveSync");
    fs.readFile(settings.syncDirectory.path + "/" + path, function (err, buf) {
        if (err) {
            log(err.message + ".\n" + err.stack, true, "FroogalDriveSync");
            return;
        }
        fileCache[path] = { stats: stats, md5: md5(buf) };
        queueCacheSave();
        queueFileUpdate({ change: "change", path: path, stats: stats, md5: md5(buf) });
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
        queueCacheSave();
        queueFileUpdate({ change: "add", path: path, stats: stats, md5: md5(buf) });
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
    return reduceFileChanges(fileChanges);
}

function reduceFileChanges(fileChanges) {
    var newFilechanges = [];
    var unlinkdirs = [];
    var unlinks = [];
    var changes = [];
    var addDirs = [];
    var adds = [];
    for (i in fileChanges) {
        var fileChange = fileChanges[i].change;
        if (fileChange == "unlinkDir") {
            unlinkdirs.push(fileChanges[i])
        } else if (fileChange == "unlink") {
            unlinks.push(fileChanges[i]);
        } else if (fileChange == "change") {
            changes.push(fileChanges[i]);
        } else if (fileChange == "addDir") {
            addDirs.push(fileChanges[i]);
        } else if (fileChange == "add") {
            adds.push(fileChanges[i]);
        }
    }
    var filteredUnlinks = [];
    for (i in unlinkdirs) {
        var udir = unlinkdirs[i].path;
        for (i2 in unlinks) {
            if (!(unlinks[i2].path.split(udir).length > 1 && !unlinks[i2].path.split(udir)[0])) {
                //only keep unlinked files not under a deleted dir
                filteredUnlinks.push(unlinks[i2]);
            }
        }
    }
    newFilechanges = newFilechanges.concat(unlinkdirs);
    newFilechanges = newFilechanges.concat(filteredUnlinks);
    newFilechanges = newFilechanges.concat(changes);
    newFilechanges = newFilechanges.concat(addDirs);
    newFilechanges = newFilechanges.concat(adds);
    return newFilechanges;
}
var cacheSaveTimeout;
function queueCacheSave() {
    clearTimeout(cacheSaveTimeout);
    cacheSaveTimeout = setTimeout(function () {
        DB.save(fileCachePath, fileCache);
        log('Changes cached.', false, "FroogalDriveSync");
    }, 500);
}
var fileUpdateTimeout;
function queueFileUpdate(fileUpdate) {
    fileUpdateQueue.push(fileUpdate);
    clearTimeout(fileUpdateTimeout);
    fileUpdateTimeout = setTimeout(function () {
        log('Sending local changes to clients...', false, "FroogalDriveSync");
        var reducedChanges = reduceFileChanges(fileUpdateQueue);
        console.log(reducedChanges); //DEBUG
        io.emit("driveChange", reducedChanges);
        fileUpdateQueue = [];
    }, 500);
}
function uninit(events, io, log, commands) {
    //Leave blank and let server know this can be reloaded
    watcher.close();
}
exports.init = init;
exports.uninit = uninit;