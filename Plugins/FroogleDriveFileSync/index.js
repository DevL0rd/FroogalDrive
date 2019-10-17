//Authour: Dustin Harris
//GitHub: https://github.com/DevL0rd
const chokidar = require('chokidar');
var watchers = {};
const fs = require('fs');
const http = require('http');
const url = require('url');
const mkdirp = require('mkdirp');
const md5 = require('md5');
const mime = require('mime-types')
const Throttle = require('throttle');
const DB = require('../../Devlord_modules/DB.js');
var httpServer
var log;
var io;
var settingsPath = __dirname + "/settings.json";
if (fs.existsSync(settingsPath)) {
    var settings = DB.load(settingsPath);
} else {
    var settings = {
        "IP": "0.0.0.0",
        "port": 8081,
        "trash": {
            "trashPath": "./Trash"
        },
        "syncDirectory": { "path": "./FroogalDrive" },
        "fileWatcher": {
            "persistent": true,
            "ignored": ['**/*.incomplete'],
            "ignoreInitial": false,
            "followSymlinks": true,
            "usePolling": true,
            "interval": 100,
            "binaryInterval": 300,
            "alwaysStat": true,
            "depth": 999,
            "awaitWriteFinish": {
                "stabilityThreshold": 2000,
                "pollInterval": 100
            },
            "ignorePermissionErrors": true,
            "atomic": true // or a custom 'atomicity delay', in milliseconds (default 100)
        },
        "throttling": {
            "videoBitRateKB": 51000,
            "audioBitRateKB": 230,
            "applicationDownloadThrottleMB": 15,
        },
        "defaultHeaders": {
            "Cache-Control": "max-age=0",
            "X-Frame-Options": "SAMEORIGIN",
            "X-XSS-Protection": "1; mode=block",
            "X-Content-Type-Options": "nosniff"
        }
    }
    DB.save(settingsPath, settings);
}
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
        httpServer = http.createServer(function (request, response) {
            if (request.method == 'GET') {
                var urlParts = url.parse(request.url);
                var reqPath = decodeURI(urlParts.pathname);
                var requestIsPath = !reqPath.includes(".");
                if (requestIsPath && reqPath.substr(reqPath.length - 1) != "/") {
                    response.writeHead(301, {
                        'Location': reqPath + "/"
                    });
                    response.end()
                    return;
                }
                var fullPath = settings.syncDirectory.path + reqPath
                var extension = reqPath.split('.').pop().toLowerCase()
                fs.exists(fullPath, function (exists) {
                    if (exists) {
                        if (request.headers['range']) {
                            sendByteRange(fullPath, request, response, function (start, end) {
                                log("[" + request.connection.remoteAddress + "] <GET> '" + reqPath + "' byte range " + start + "-" + end + " requested.", false, "HTTP");
                            }, function (start, end) {
                                log("[" + request.connection.remoteAddress + "] <GET> '" + reqPath + "' byte range " + start + "-" + end + " sent!", false, "HTTP");
                            });
                        } else {
                            sendFile(fullPath, request, response, function (isCached) {
                                if (isCached) {
                                    log("[" + request.connection.remoteAddress + "] <GET> (cached) '" + reqPath + "'.", false, "HTTP");
                                } else {
                                    log("[" + request.connection.remoteAddress + "] <GET> '" + reqPath + "' requested.", false, "HTTP");
                                }
                            }, function (isCached) {
                                if (!isCached) {
                                    log("[" + request.connection.remoteAddress + "] <GET> '" + reqPath + "' sent!", false, "HTTP");
                                }
                            });
                        }
                    } else {
                        log("[" + request.connection.remoteAddress + "] <GET> '" + reqPath + "' not found!", true, "HTTP");
                        response.writeHead(404);
                        response.end();
                        return;
                    }
                });
            }
        });
        httpServer.listen(settings.port, settings.IP);
        events.on("connection", function (socket) {
            socket.on('registerClient', function () {
                if (socket.isLoggedIn) {
                    socket.emit('clientRegistered', socket.email);
                    initWatcher(socket, function () {
                        fileCache[socket.email] = watchers[socket.email].newFileCache;
                    });
                } else {
                    socket.emit('clientRegisterFailedLogin');
                }
            });
            socket.on('getFileCache', function () {
                if (socket.isLoggedIn) {
                    socket.emit('getFileCache', fileCache[socket.email]);
                }
            });
            socket.on('driveChange', function (fileChanges) {
                if (socket.isLoggedIn) {
                    doFileChanges(fileChanges, socket, function () {
                        socket.emit('driveChangeComplete');
                    });
                }
            });
        });

        events.on("uploadComplete", function (request, response, urlParts, file, fields) {
            if (requestFileCallbacks[fields.requestID]) { //request must be valid
                var oldpath = file.path; //the files temp directory path
                var newpath = settings.syncDirectory.path + "/" + fields.email + "/" + fields.path; //the files new path
                if (fs.existsSync(newpath)) {
                    fs.unlink(newpath, function (err) {
                        if (err) {
                            log(err.message + ".\n" + err.stack, true, "FroogalDriveSync");
                            return;
                        }
                        fs.rename(oldpath, newpath, function (err) {
                            if (err) {
                                log(err.message + ".\n" + err.stack, true, "FroogalDriveSync");
                                return;
                            }
                            response.writeHead(200);
                            response.end();
                            requestFileCallbacks[fields.requestID]();
                            delete requestFileCallbacks[fields.requestID];
                        });
                    });
                } else {
                    fs.rename(oldpath, newpath, function (err) {
                        if (err) {
                            log(err.message + ".\n" + err.stack, true, "FroogalDriveSync");
                            return;
                        }
                        response.writeHead(200);
                        response.end();
                        requestFileCallbacks[fields.requestID]();
                        delete requestFileCallbacks[fields.requestID];
                    });
                }
            }
        });
    }
}
function initWatcher(socket, doneCallback) {
    if (!watchers[socket.email]) {
        //start watching directories
        watchers[socket.email] = { newFileCache: {}, sockets: [socket] };
        fileCache[socket.email] = {};
        var accountPath = settings.syncDirectory.path + "/" + socket.email
        mkdirp(accountPath, function (err) {
            if (err) {
                log(err.message + ".\n" + err.stack, true, "FroogalDriveSync");
            };
        });
        settings.fileWatcher.ignoreInitial = false;
        settings.fileWatcher.cwd = accountPath;
        watchers[socket.email].watcher = chokidar.watch(accountPath, settings.fileWatcher);
        watchers[socket.email].fileUpdateQueue = [];
        watchers[socket.email].watcher.on('add', function (path, stats) {
            log("File '" + path + "' scanned.", false, "FroogalDriveSync");
            var accountFilePath = accountPath + "/" + path;
            fs.readFile(accountFilePath, function (err, buf) {
                if (err) {
                    log(err.message + ".\n" + err.stack, true, "FroogalDriveSync");
                    return;
                }
                watchers[socket.email].newFileCache[path] = { stats: stats, md5: md5(buf) };
                triggerWatcherReady(socket.email, doneCallback);
            });
        });
        watchers[socket.email].watcher.on('addDir', function (path, stats) {
            if (path) { //ignore root dir
                log("Directory '" + path + "' scanned.", false, "FroogalDriveSync");
                watchers[socket.email].newFileCache[path] = { stats: stats };
                triggerWatcherReady(socket.email, doneCallback);
            }
        });
        watchers[socket.email].watcher.on('ready', function () {
            //not an accurate after inital scan time
            triggerWatcherReady(socket.email, doneCallback);
        });
    } else {
        watchers[socket.email].sockets.push(socket);
    }

}
var watcherReadyTimeout
function triggerWatcherReady(email, doneCallback) {
    clearTimeout(watcherReadyTimeout);
    var watcher = watchers[email].watcher;
    watcherReadyTimeout = setTimeout(function () {
        queueCacheSave();
        settings.fileWatcher.ignoreInitial = true;
        watcher.close();
        var accountPath = settings.syncDirectory.path + "/" + email
        settings.fileWatcher.ignoreInitial = false;
        settings.fileWatcher.cwd = accountPath;
        watcher = chokidar.watch(accountPath, settings.fileWatcher);
        watcher.on('add', function (path, stats) {
            add(path, stats, email);
        });
        watcher.on('change', function (path, stats) {
            change(path, stats, email);
        });
        watcher.on('unlink', function (path) {
            unlink(path, email);
        });
        watcher.on('addDir', function (path, stats) {
            addDir(path, stats, email);
        });
        watcher.on('unlinkDir', function (path, stats) {
            unlinkDir(path, email);
        });
        watcher.on('ready', function () {
            doneCallback();
        });
    }, 1000);
}
function unlink(path, email) {
    log("File '" + path + "' removed. Sending update to clients.", false, "FroogalDriveSync");
    delete fileCache[email][path];
    queueCacheSave();
    watchers[email].fileUpdateQueue.push({ change: "unlink", path: path });
    queueFileUpdate();
}
function unlinkDir(path, email) {
    log("Directory '" + path + "' removed. Sending update to clients.", false, "FroogalDriveSync");
    delete fileCache[email][path];
    queueCacheSave();
    watchers[email].fileUpdateQueue.push({ change: "unlinkDir", path: path });
    queueFileUpdate();
}
function addDir(path, stats, email) {
    log("Directory '" + path + "' added. Sending update to clients.", false, "FroogalDriveSync");
    fileCache[email][path] = { stats: stats };
    queueCacheSave();
    watchers[email].fileUpdateQueue.push({ change: "addDir", path: path, stats: stats });
    queueFileUpdate();
}
function change(path, stats, email) {
    log("File '" + path + "' modified. Sending update to clients.", false, "FroogalDriveSync");
    fs.readFile(settings.syncDirectory.path + "/" + email + "/" + path, function (err, buf) {
        if (err) {
            log(err.message + ".\n" + err.stack, true, "FroogalDriveSync");
            return;
        }
        fileCache[email][path] = { stats: stats, md5: md5(buf) };
        queueCacheSave();
        watchers[email].fileUpdateQueue.push({ change: "change", path: path, stats: stats, md5: md5(buf) });
        queueFileUpdate();
    });
}
function add(path, stats, email) {
    log("File '" + path + "' added. Sending update to clients.", false, "FroogalDriveSync");
    fs.readFile(settings.syncDirectory.path + "/" + email + "/" + path, function (err, buf) {
        if (err) {
            log(err.message + ".\n" + err.stack, true, "FroogalDriveSync");
            return;
        }
        fileCache[email][path] = { stats: stats, md5: md5(buf) };
        queueCacheSave();
        watchers[email].fileUpdateQueue.push({ change: "add", path: path, stats: stats, md5: md5(buf) });
        queueFileUpdate();
    });
}
function deleteFolderRecursive(path) {
    if (fs.existsSync(path)) {
        fs.readdirSync(path).forEach(function (file, index) {
            var curPath = path + "/" + file;
            if (fs.lstatSync(curPath).isDirectory()) { // recurse
                deleteFolderRecursive(curPath);
            } else { // delete file
                fs.unlinkSync(curPath);
            }
        });
        fs.rmdirSync(path);
    }
};
var requestFileCallbacks = {};
function requestFile(path, socket, rcallback) {
    var requestID = io.generate_key();
    socket.emit("getFile", { path: path, requestID: requestID });
    requestFileCallbacks[requestID] = rcallback;
}

function doFileChanges(fileChanges, socket, fcCallback, i = -1) {

    i++;
    if (i > fileChanges.length - 1) return fcCallback();
    var fileChange = fileChanges[i];
    var localFilePath = settings.syncDirectory.path + "/" + socket.email + "/" + fileChange.path;
    if (fileChange.change == "unlinkDir") {
        if (fs.existsSync(localFilePath)) {
            delete fileCache[socket.email][fileChange.path];
            queueCacheSave();
            deleteFolderRecursive(localFilePath);
        }
        doFileChanges(fileChanges, socket, fcCallback, i);
    } else if (fileChange.change == "unlink") {
        if (fs.existsSync(localFilePath)) {
            delete fileCache[socket.email][fileChange.path];
            queueCacheSave();
            fs.unlink(localFilePath, function (err) {
                if (err) {
                    log(err.message + ".\n" + err.stack, true, "FroogalDriveSync");
                    return
                }
                doFileChanges(fileChanges, socket, fcCallback, i);
            });
        } else {
            doFileChanges(fileChanges, socket, fcCallback, i);
        }
    } else if (fileChange.change == "change") {
        if (fs.existsSync(localFilePath)) {
            fileCache[socket.email][fileChange.path] = { stats: fileChange.stats, md5: fileChange.md5 };
            queueCacheSave();
            fs.readFile(localFilePath, function (err, buf) {
                if (err) {
                    log(err.message + ".\n" + err.stack, true, "FroogalDriveSync");
                    return;
                }
                var lmd5 = md5(buf);
                if (lmd5 != fileChange.md5) {
                    //get new file if different
                    log("File '" + fileChange.path + "' changed.", false, "FroogalDriveSync");
                    requestFile(fileChange.path, socket, function () {
                        doFileChanges(fileChanges, socket, fcCallback, i);
                        log("File '" + fileChange.path + "' downloaded.", false, "FroogalDriveSync");
                    });
                } else {
                    doFileChanges(fileChanges, socket, fcCallback, i);
                }
            });
        } else {
            log("File '" + fileChange.path + "' changed but is missing, downloading file.", false, "FroogalDriveSync");
            requestFile(fileChange.path, socket, function () {
                doFileChanges(fileChanges, socket, fcCallback, i);
                log("File '" + fileChange.path + "' downloaded.", false, "FroogalDriveSync");
            });
        }
    } else if (fileChange.change == "addDir") {
        if (!fs.existsSync(localFilePath)) {
            fileCache[socket.email][fileChange.path] = { stats: fileChange.stats };
            queueCacheSave();
            fs.mkdirSync(localFilePath);
        }
        doFileChanges(fileChanges, socket, fcCallback, i);
    } else if (fileChange.change == "add") {
        if (!fs.existsSync(localFilePath)) {
            fileCache[socket.email][fileChange.path] = { stats: fileChange.stats, md5: fileChange.md5 };
            queueCacheSave();
            requestFile(fileChange.path, socket, function () {
                doFileChanges(fileChanges, socket, fcCallback, i);
                log("File '" + fileChange.path + "' downloaded.", false, "FroogalDriveSync");
            });
        } else {
            fileCache[socket.email][fileChange.path] = { stats: fileChange.stats, md5: fileChange.md5 };
            queueCacheSave();
            fs.readFile(localFilePath, function (err, buf) {
                if (err) {
                    log(err.message + ".\n" + err.stack, true, "FroogalDriveSync");
                    return;
                }
                var lmd5 = md5(buf);
                if (lmd5 != fileChange.md5) {
                    //get new file if different
                    log("File '" + fileChange.path + "' changed.", false, "FroogalDriveSync");
                    requestFile(fileChange.path, socket, function () {
                        doFileChanges(fileChanges, socket, fcCallback, i);
                        log("File '" + fileChange.path + "' downloaded.", false, "FroogalDriveSync");
                    });
                } else {
                    doFileChanges(fileChanges, socket, fcCallback, i);
                }
            });
        }
    } else {
        doFileChanges(fileChanges, socket, fcCallback, i);
    }

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
    // var filteredUnlinks = [];
    // for (i in unlinkdirs) {
    //     var udir = unlinkdirs[i].path;
    //     for (i2 in unlinks) {
    //         console.log(unlinks[i2].path.split(udir));
    //         if (!(unlinks[i2].path.split(udir).length > 1 && !unlinks[i2].path.split(udir)[0])) {
    //             //only keep unlinked files not under a deleted dir
    //             filteredUnlinks.push(unlinks[i2]);
    //         }
    //     }
    // }
    newFilechanges = newFilechanges.concat(unlinkdirs);
    //newFilechanges = newFilechanges.concat(filteredUnlinks);
    newFilechanges = newFilechanges.concat(unlinks); //fix unlink filter
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
        //log('Changes cached.', false, "FroogalDriveSync");
    }, 500);
}
var fileUpdateTimeout;
function queueFileUpdate() {
    clearTimeout(fileUpdateTimeout);
    fileUpdateTimeout = setTimeout(function () {
        log('Sending changes to clients...', false, "FroogalDriveSync");
        for (i in watchers) {
            var watcher = watchers[i];
            if (watcher.fileUpdateQueue.length) {
                var reducedChanges = reduceFileChanges(watcher.fileUpdateQueue);
                for (i2 in watcher.sockets) {
                    var socket = watcher.sockets[i2];
                    socket.emit("driveChange", reducedChanges);
                }
                watcher.fileUpdateQueue = [];
            }
        }
    }, 500);
}
function sendFile(reqPath, request, response, callback) {
    fs.stat(reqPath, function (err, stat) {
        if (!err) {
            var reqModDate = request.headers["if-modified-since"];
            //remove milliseconds from modified date, some browsers do not keep the date that accurately.
            if (reqModDate && Math.floor(new Date(reqModDate).getTime() / 1000) == Math.floor(stat.mtime.getTime() / 1000)) {
                response.writeHead(304, {
                    "Last-Modified": stat.mtime.toUTCString()
                });
                response.end();
                callback(true);
            } else {
                var mimeType = getMime(reqPath);
                var header = buildHeader(mimeType, stat);
                response.writeHead(200, header);
                var fileStream = fs.createReadStream(reqPath);
                pipeFileToResponse(fileStream, mimeType, response);
                callback(false);
                fileStream.on('end', () => {
                });
            }
        } else {
            log(err.message + ".\n" + err.stack, true, "HTTP");
        }
    });
}

function buildHeader(mimeType = "application/octet-stream", stat, otherOptions = {}) {
    var contentLength = stat.size;
    var lastModified = stat.mtime.toUTCString();
    var header = {
        'Content-Length': contentLength,
        'Content-Type': mimeType,
        "Last-Modified": lastModified
    };
    header = Object.assign(header, settings.defaultHeaders)
    header = Object.assign(header, otherOptions);
    return header;
}

function sendByteRange(fullPath, request, response, callback) {
    fs.stat(fullPath, function (err, stat) {
        if (!err) {
            var total = stat.size;
            var range = request.headers.range;
            var parts = range.replace(/bytes=/, "").split("-");
            var partialstart = parts[0];
            var partialend = parts[1];
            var start = parseInt(partialstart, 10);
            var end = partialend ? parseInt(partialend, 10) : total - 1;
            start = isNaN(start) ? 0 : start
            var chunksize = (end - start);
            if (start >= 0 && start <= end && end <= total - 1) {
                var mimeType = getMime(fullPath);
                var header = buildHeader(mimeType, stat, {
                    'Content-Range': 'bytes ' + start + '-' + end + '/' + total,
                    'Content-Length': start == end ? 0 : (end - start + 1),
                    'Accept-Ranges': 'bytes'
                });
                response.writeHead(206, header);
                var fileStream = fs.createReadStream(fullPath, {
                    start: start,
                    end: end
                });
                pipeFileToResponse(fileStream, mimeType, response);

                callback(start, end);
                fileStream.on('end', () => {

                });
            } else {
                log("[" + request.connection.remoteAddress + "] <GET> '" + fullPath + "' Invalid byte range! (" + start + '-' + end + '/' + total + ")", true, "HTTP");
                var header = buildHeader(mimeType, stat, {
                    'Content-Range': 'bytes */' + stat.size
                });
                response.writeHead(416, header);
                response.end();
            }
        } else {
            log(err.message + ".\n" + err.stack, true, "HTTP");
        }
    });
}

function getMime(path) {
    return mime.lookup(path) || 'application/octet-stream';
}
function pipeFileToResponse(fileStream, mimeType, response) {
    var contentCategory = mimeType.split("/")[0]
    if (contentCategory == "video") {
        fileStream.pipe(new Throttle(settings.throttling.videoBitRateKB * 1000)).pipe(response);
    } else if (contentCategory == "audio") {
        fileStream.pipe(new Throttle(settings.throttling.audioBitRateKB * 1000)).pipe(response);
    } else if (contentCategory == "application") {
        fileStream.pipe(new Throttle(settings.throttling.applicationDownloadThrottleMB * 1000000)).pipe(response);
    } else {
        fileStream.pipe(response);
    }
}

function uninit(events, io, log, commands) {
    //Leave blank and let server know this can be reloaded
    watcher.close();
}
exports.init = init;
exports.uninit = uninit;