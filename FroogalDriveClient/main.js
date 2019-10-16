

const DB = require('./Devlord_modules/DB.js');
const windowStateKeeper = require('electron-window-state');
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const http = require('http');
const request = require('request');
const mkdirp = require('mkdirp');
const chokidar = require('chokidar');
const md5 = require('md5');
const AU = require('ansi_up');
const cc = require('./Devlord_modules/conColors.js');
const cs = require('./Devlord_modules/conSplash.js');
const ansi_up = new AU.default;
var socket;
var watcher;
let mainWindow
var args = process.argv.slice(5);
var settingsPath = __dirname + "/settings.json";
if (fs.existsSync(settingsPath)) {
  var settings = DB.load(settingsPath);
} else {
  var settings = {
    "IP": "0.0.0.0",
    "port": 8081,
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
    "debug": true,
    "accentColor": {
      "r": 50,
      "g": 50,
      "b": 50,
      "a": 0.9
    },
    "rainbowEnabled": false,
    "devToolsOnStartup": false
  }
  DB.save(settingsPath, settings);
}
settings.fileWatcher.cwd = settings.syncDirectory.path;
mkdirp(settings.syncDirectory.path, function (err) {
  if (err) {
    log(err.message + ".\n" + err.stack);
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
function createWindow() {
  // Load the previous state with fallback to defaults
  let mainWindowState = windowStateKeeper({
    defaultWidth: 720,
    defaultHeight: 500
  });
  // Create the browser window.
  mainWindow = new BrowserWindow({
    x: mainWindowState.x,
    y: mainWindowState.y,
    width: mainWindowState.width,
    height: mainWindowState.height,
    minWidth: 720,
    minHeight: 500,
    webPreferences: {
      nodeIntegration: true
    },
    transparent: true,
    resizable: true,
    frame: false
  })
  mainWindowState.manage(mainWindow);
  mainWindow.setMenu(null);
  // and load the index.html of the app.
  mainWindow.loadFile('index.html');
  //fix transparency bug in windows 10
  mainWindow.reload();

  // Emitted when the window is closed.
  mainWindow.on('closed', function () {
    // Dereference the window object, usually you would store windows
    // in an array if your app supports multi windows, this is the time
    // when you should delete the corresponding element.
    mainWindow = null
  });
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', function () { setTimeout(createWindow, 300) });

// Quit when all windows are closed.
app.on('window-all-closed', function () {
  // On macOS it is common for applications and their menu bar
  // to stay active until the user quits explicitly with Cmd + Q
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', function () {
  // On macOS it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (mainWindow === null) createWindow()
})

app.on('browser-window-created', function (e, window) {
  window.setMenu(null);
});


// ipcMain.on('consoleCommand', (event, fullMessage) => {
//   var args = fullMessage.split(" ");
//   var command = args.shift().toLowerCase();
//   if (mws.commands[command]) {
//     mws.commands[command].do(args, fullMessage)
//   } else {
//     mws.log("Unknown command '" + command + "'.", true, "CONSOLE")
//   }
// })
var htmlLoggingSender
ipcMain.on('registerForHTMLLogging', (event, arg) => {
  htmlLoggingSender = event.sender
});
var io = require('socket.io-client');
var mainServerUrl = "http://" + settings.IP + ":8081";
function formatAndColorString(str) {
  var cstringColoredQuotes = cc.fg.white + str.replace(/\'.*\'/, cc.style.underscore + cc.fg.cyan + '$&' + cc.reset + cc.style.bright + cc.fg.white);
  return cc.fg.white + cstringColoredQuotes + cc.reset + cc.fg.white;
}
function log(str) {
  var fString = formatAndColorString(str);
  console.log(fString);
  if (htmlLoggingSender) {
    htmlLoggingSender.send('log', ansi_up.ansi_to_html(fString.replace("  ", "\xa0")) + "<br>");
  }
}

socket = io("http://" + settings.IP + ":80", {
  reconnect: true
});
var initialSync = true;
socket.on("connect", function () {
  log("Connected to FroogalDrive server. Starting file system watcher...");
  initWatcher(function () {
    initialSync = true;
    var changedFiles = getChangedFiles(newFileCache, fileCache);
    socket.emit("driveChange", changedFiles); //emit local files to server before getting server updates
    fileCache = newFileCache; //update cache
    queueCacheSave();
  });
});
socket.on("driveChangeComplete", function () {
  if (initialSync) {
    socket.emit("getFileCache");
  }
});
socket.on("disconnect", function () {
  watcher.close();
});
socket.on('driveChange', function (fileChanges) {
  doFileChanges(fileChanges, socket, function () {

  });
});
socket.on('getFileCache', function (nFileCache) {
  var fileChanges = getChangedFiles(nFileCache, fileCache);
  doFileChanges(fileChanges, socket, function () {
    if (initialSync) {
      log("Initial sync complete");
      initialSync = false;
    }
  });
});
socket.on('getFile', function (data) {
  var localFilePath = settings.syncDirectory.path + "/" + data.path;
  uploadFile(localFilePath, { "auth": "todo", "path": data.path, "requestID": data.requestID });
});
function uploadFile(path, meta = {}) {
  var r = request.post("http://" + settings.IP + "/upload", function (err, httpResponse, body) {
    if (err) {
      return log(err.message + ".\n" + err.stack);
    }
  });
  var form = r.form()
  for (i in meta) {
    form.append(i, meta[i]);
  }
  form.append('file', fs.createReadStream(path));

}
function doFileChanges(fileChanges, socket, fcCallback, i = -1) {

  i++;
  if (i > fileChanges.length - 1) return fcCallback();
  var fileChange = fileChanges[i];
  var localFilePath = settings.syncDirectory.path + "/" + fileChange.path;
  if (fileChange.change == "unlinkDir") {
    if (fs.existsSync(localFilePath)) {
      delete fileCache[fileChange.path];
      queueCacheSave();
      deleteFolderRecursive(localFilePath);
    }
    doFileChanges(fileChanges, socket, fcCallback, i);
  } else if (fileChange.change == "unlink") {
    if (fs.existsSync(localFilePath)) {
      delete fileCache[fileChange.path];
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
      fileCache[fileChange.path] = { stats: fileChange.stats, md5: fileChange.md5 };
      queueCacheSave();
      fs.readFile(localFilePath, function (err, buf) {
        var lmd5 = md5(buf);
        if (lmd5 != fileChange.md5) {
          //get new file if different
          log("File '" + fileChange.path + "' changed.", false, "FroogalDriveSync");
          downloadFile(mainServerUrl + "/" + fileChange.path, settings.syncDirectory.path + "/" + fileChange.path, function () {
            doFileChanges(fileChanges, socket, fcCallback, i);
            log("File '" + fileChange.path + "' downloaded.", false, "FroogalDriveSync");
          })
        } else {
          doFileChanges(fileChanges, socket, fcCallback, i);
        }
      });
    } else {
      log("File '" + fileChange.path + "' changed but is missing, downloading file.", false, "FroogalDriveSync");
      downloadFile(mainServerUrl + "/" + fileChange.path, settings.syncDirectory.path + "/" + fileChange.path, function () {
        doFileChanges(fileChanges, socket, fcCallback, i);
        log("File '" + fileChange.path + "' downloaded.", false, "FroogalDriveSync");
      })
    }
  } else if (fileChange.change == "addDir") {
    if (!fs.existsSync(localFilePath)) {
      fileCache[fileChange.path] = { stats: fileChange.stats };
      queueCacheSave();
      fs.mkdirSync(localFilePath);
    }
    doFileChanges(fileChanges, socket, fcCallback, i);
  } else if (fileChange.change == "add") {
    if (!fs.existsSync(localFilePath)) {
      fileCache[fileChange.path] = { stats: fileChange.stats, md5: fileChange.md5 };
      queueCacheSave();
      downloadFile(mainServerUrl + "/" + fileChange.path, settings.syncDirectory.path + "/" + fileChange.path, function () {
        doFileChanges(fileChanges, socket, fcCallback, i);
        log("File '" + fileChange.path + "' downloaded.", false, "FroogalDriveSync");
      })
    } else {
      doFileChanges(fileChanges, socket, fcCallback, i);
      //if file already exists and the server says it is new. Do something.
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
function downloadFile(from, to, callbackRename) {
  const file = fs.createWriteStream(to + ".incomplete");
  const request = http.get(from, function (response) {
    if (response.statusCode == 200) {
      response.pipe(file);
      response.on('end', function () {
        fs.rename(to + ".incomplete", to, function (err) {
          if (err) log(err.message + ".\n" + err.stack, true, "Server");
          callbackRename();
        });
      })
    }
  });
}
function initWatcher(doneCallback) {
  //start watching directories
  newFileCache = {};
  var path = settings.syncDirectory.path;
  settings.fileWatcher.ignoreInitial = false;
  watcher = chokidar.watch(path, settings.fileWatcher);
  watcher.on('add', function (path, stats) {
    log("File '" + path + "' scanned.");
    fs.readFile(settings.syncDirectory.path + "/" + path, function (err, buf) {
      if (err) {
        log(err.message + ".\n" + err.stack);
        return;
      }
      newFileCache[path] = { stats: stats, md5: md5(buf) };
      triggerWatcherReady(doneCallback);
    });
  });
  watcher.on('addDir', function (path, stats) {
    if (path) { //ignore root dir
      log("Directory '" + path + "' scanned.");
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
    settings.fileWatcher.ignoreInitial = true;
    watcher.close();
    watcher = chokidar.watch(settings.syncDirectory.path, settings.fileWatcher);
    watcher.on('add', add);
    watcher.on('change', change);
    watcher.on('unlink', unlink);
    watcher.on('addDir', addDir);
    watcher.on('unlinkDir', unlinkDir);
    watcher.on('ready', function () {
      log('FroogalDrive file scan complete! Watching for changes...');
      doneCallback();
    });
  }, 1000);
}
function unlink(path) {
  log("File '" + path + "' removed.");
  delete fileCache[path];
  queueCacheSave();
  queueFileUpdate({ change: "unlink", path: path });
}
function unlinkDir(path) {
  log("Directory '" + path + "' removed.");
  delete fileCache[path];
  queueCacheSave();
  queueFileUpdate({ change: "unlinkDir", path: path });
}
function addDir(path, stats) {
  log("Directory '" + path + "' added.");
  fileCache[path] = { stats: stats };
  queueCacheSave();
  queueFileUpdate({ change: "addDir", path: path, stats: stats });
}
function change(path, stats) {
  log("File '" + path + "' modified.");
  fs.readFile(settings.syncDirectory.path + "/" + path, function (err, buf) {
    if (err) {
      log(err.message + ".\n" + err.stack);
      return;
    }
    fileCache[path] = { stats: stats, md5: md5(buf) };
    queueCacheSave();
    queueFileUpdate({ change: "change", path: path, stats: stats, md5: md5(buf) });
  });
}
function add(path, stats) {
  log("File '" + path + "' added.");
  fs.readFile(settings.syncDirectory.path + "/" + path, function (err, buf) {
    if (err) {
      log(err.message + ".\n" + err.stack);
      return;
    }
    fileCache[path] = { stats: stats, md5: md5(buf) };
    queueCacheSave();
    queueFileUpdate({ change: "add", path: path, stats: stats, md5: md5(buf) });
  });
}

var cacheSaveTimeout;
function queueCacheSave() {
  clearTimeout(cacheSaveTimeout);
  cacheSaveTimeout = setTimeout(function () {
    DB.save(fileCachePath, fileCache);
  }, 500);
}
var fileUpdateTimeout;
function queueFileUpdate(fileUpdate) {
  clearTimeout(fileUpdateTimeout);
  if (!initialSync) {
    fileUpdateQueue.push(fileUpdate);
    fileUpdateTimeout = setTimeout(function () {
      log('Sending local changes to server...');
      var reducedChanges = reduceFileChanges(fileUpdateQueue);
      socket.emit("driveChange", reducedChanges);
      fileUpdateQueue = [];
    }, 500);
  }
}