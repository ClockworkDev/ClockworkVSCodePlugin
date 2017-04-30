// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
var vscode = require('vscode');
var exec = require('child_process').exec;
var clockworkTools = require('clockwork-tools')(vscode.workspace.rootPath + "/", function (data, callback) {
    var requiredData = [];
    for (var field in data.properties) {
        var currentProp = data.properties[field];
        requiredData.push({
            id: field,
            description: currentProp.description,
            pattern: currentProp.pattern
        });
    }
    function askInformation(requiredInformation, answer) {
        if (requiredInformation.length == 0) {
            return callback(undefined, answer);
        }
        var nextQuestion = requiredInformation[0];
        vscode.window.showInputBox({ prompt: nextQuestion.description }).then(function (value) {
            if (nextQuestion.pattern && !nextQuestion.pattern.test(value)) {
                vscode.window.showErrorMessage("The value is invalid, please try again.")
                askInformation(requiredInformation, answer);
            } else {
                answer[nextQuestion.id] = value;
                requiredInformation.shift();
                askInformation(requiredInformation, answer);
            }
        });
    }
    return askInformation(requiredData, {});
}, function (msg) {
    console.log(msg);
    // vscode.window.showInformationMessage(msg);
},
    function (msg) {
        vscode.window.showErrorMessage(msg);
    });



const initialConfigurations = {
    version: '0.1.0',
    configurations: [
        {
            type: 'clockwork',
            request: 'launch',
            name: 'Clockwork',
            stopOnEntry: false,
            program: "${workspaceRoot}/manifest.json"
        }
    ]
}


const serverPort = 3000;

var Server = function () {
    var file = null;
    var app = require('express')();
    var server = require('http').Server(app);
    server.listen(serverPort);
    app.get('/deployPackage', function (req, res) {
        res.sendFile(file);
    });
    return {
        setDeployPackage: function (someFile) {
            file = someFile;
        }
    }
}

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
function activate(context) {
    var deployServer = null;
    // Use the console to output diagnostic information (console.log) and errors (console.error)
    // This line of code will only be executed once when your extension is activated
    console.log('Congratulations, your extension "clockwork" is now active!');

    // The command has been defined in the package.json file
    // Now provide the implementation of the command with  registerCommand
    // The commandId parameter must match the command field in package.json
    var disposable = vscode.commands.registerCommand('extension.createProject', function () {
        var thisExtension = vscode.extensions.getExtension('arcadio.clockwork');
        vscode.window.showInputBox({ prompt: "What is the name of your proyect?" }).then(function (name) {
            clockworkTools.createProject(name);
            vscode.window.showInformationMessage(`Project ${name} created successfully`);
        })
    });
    context.subscriptions.push(disposable);

    function buildProject(callback) {
        var thisExtension = vscode.extensions.getExtension('arcadio.clockwork');
        clockworkTools.buildProject(callback);
    }

    disposable = vscode.commands.registerCommand('extension.buildProject', function () {
        buildProject(function (name) {
            vscode.window.showInformationMessage(`Project built successfully at ${name}`);
        });
    });
    context.subscriptions.push(disposable);

    disposable = vscode.commands.registerCommand('extension.deployPackage', function () {
        var manifest = readManifest();
        if (manifest != null) {
            buildProject(function (name) {
                if (!deployServer) {
                    deployServer = Server();
                }
                deployServer.setDeployPackage(vscode.workspace.rootPath + "/" + manifest.name + ".cw");
                const opn = require('opn');
                opn("cwrt://localhost:" + serverPort + "/deployPackage");
            });
        }
    });
    context.subscriptions.push(disposable);

    disposable = vscode.commands.registerCommand('extension.unlockRuntime', function () {
        exec("powershell.exe -command \"checknetisolation loopbackexempt -a -n=\\\"58996ARCADIOGARCA.ClockworkRuntime_vf445mhh8ay3y\\\"\"", function (err, stdout, stderr) {
            console.log(stdout);
            console.log(stderr);
        });
    });
    context.subscriptions.push(disposable);

    disposable = vscode.commands.registerCommand('extension.packageDoc', function () {
        const opn = require('opn');
        vscode.window.showInputBox({ prompt: "Package name:" }).then(function (name) {
            var manifest = readManifest();
            var version = manifest.dependencies[name];
            if (typeof version !== "undefined") {
                vscode.commands.executeCommand('vscode.previewHtml', "http://cwpm.azurewebsites.net/api/doc/" + name + "/" + version, 2, name);
            } else {
                vscode.window.showInputBox({ prompt: "Package version:" }).then(function (version) {
                    opn("http://cwpm.azurewebsites.net/api/doc/" + name + "/" + version);
                });
            }
        })
    });
    context.subscriptions.push(disposable);

    vscode.workspace.registerTextDocumentContentProvider('clockwork-doc', provider2);



    function readManifest(safeMode) {
        try {
            var manifest = require(vscode.workspace.rootPath + '/manifest.json');
        } catch (e) {
            vscode.window.showErrorMessage("There is no Clockwork project in this folder! (manifest.json is missing)");
            vscode.window.showErrorMessage("If you want to create a new Clockwork game, run 'Create Clockwork project'");
            return null;
        }
        return manifest;
    }


    //Debugger

    context.subscriptions.push(vscode.commands.registerCommand('extension.provideInitialConfigurations', () => {
        return [
            '// Use IntelliSense to learn about possible Clockwork debug attributes.',
            '// Hover to view descriptions of existing attributes.',
            JSON.stringify(initialConfigurations, null, '\t')
        ].join('\n');
    }));


}
exports.activate = activate;

// this method is called when your extension is deactivated
function deactivate() {
}
exports.deactivate = deactivate;