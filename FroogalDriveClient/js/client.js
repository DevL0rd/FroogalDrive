//Authour: Dustin Harris
//GitHub: https://github.com/DevL0rd
const remote = require('electron').remote;
const dialog = remote.dialog;
const fs = require('fs')
var DB = require('./Devlord_modules/DB.js');
Element.prototype.remove = function () {
    this.parentElement.removeChild(this);
}
//IE support string includes
if (!String.prototype.includes) {
    String.prototype.includes = function (search, start) {
        'use strict';
        if (typeof start !== 'number') {
            start = 0;
        }
        if (start + search.length > this.length) {
            return false;
        } else {
            return this.indexOf(search, start) !== -1;
        }
    };
}
//IE support array includes
if (!Array.prototype.includes) {
    Object.defineProperty(Array.prototype, "includes", {
        enumerable: false,
        value: function (obj) {
            var newArr = this.filter(function (el) {
                return el == obj;
            });
            return newArr.length > 0;
        }
    });
}
document.getElementById("min-btn").addEventListener("click", function (e) {
    var window = remote.getCurrentWindow();
    window.minimize();
});
var isMaximized = false;
document.getElementById("max-btn").addEventListener("click", function (e) {
    var window = remote.getCurrentWindow();
    // !window.isMaximized()
    if (!isMaximized) {
        isMaximized = true;
        window.maximize();
    } else {
        isMaximized = false;
        window.unmaximize();
    }
});

document.getElementById("close-btn").addEventListener("click", function (e) {
    var window = remote.getCurrentWindow();
    window.close();
});

document.getElementById("dev-btn").addEventListener("click", function (e) {
    openDevTools();
});
function openDevTools() {
    var window = remote.getCurrentWindow();
    window.webContents.openDevTools();
}
document.getElementById("rld-btn").addEventListener("click", function (e) {
    location.reload();
});

document.addEventListener('DOMContentLoaded', function () {
    $("#pageLoadingCover").fadeOut(1000);
});

//PROJECT CODE STARTS HERE

var ipcRenderer = require('electron').ipcRenderer;
var logTimeout
ipcRenderer.on('log', function (event, genHtml) {
    $("#consoleContainer").append(genHtml);
    $("#fullConsoleContainer").append(genHtml);
    $("#statusbartext").html("Console: " + genHtml);
    clearTimeout(logTimeout);
    logTimeout = setTimeout(function () {
        $("#consoleContainer").animate({ scrollTop: $('#consoleContainer').prop("scrollHeight") }, 300);
        $("#fullConsoleContainer").animate({ scrollTop: $('#fullConsoleContainer').prop("scrollHeight") }, 300);
    }, 300);
});
ipcRenderer.send('registerForHTMLLogging');

function consoleCommand(command) {
    ipcRenderer.send('consoleCommand', command);
}


$("#fullConsole-btn").click(function () {
    $(".toolBoxApp").hide();
    $("#fullConsole").fadeIn(400);
    $('#browser').attr('src', "");
    $('#fullConsole-btn').tooltip('hide');
});
$("#settings-btn").click(function () {
    $(".toolBoxApp").hide();
    $("#settings").fadeIn(400);
    $('#browser').attr('src', "");
    $('#settings-btn').tooltip('hide');
});
var consoleVisible = false;
$("#console-btn").click(function () {
    $('#console-btn').tooltip('hide');
    if (consoleVisible) {
        $("#console").fadeOut(400);
        consoleVisible = false;
    } else {
        $("#console").fadeIn(400);
        consoleVisible = true;
    }
});
$('#consoleInput').keypress(function (e) {
    if (e.which == 13) {
        ipcRenderer.send('consoleCommand', $('#consoleInput').val());
        $('#consoleInput').val("");
        return false;    //<---- Add this line
    }
});
$('#fullConsoleInput').keypress(function (e) {
    if (e.which == 13) {
        ipcRenderer.send('consoleCommand', $('#fullConsoleInput').val());
        $('#fullConsoleInput').val("");
        return false;    //<---- Add this line
    }
});