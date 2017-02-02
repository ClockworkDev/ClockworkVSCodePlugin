// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
var vscode = require('vscode');
var exec = require('child_process').exec;

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
function activate(context) {
    const serverPort = 3000;
    // Use the console to output diagnostic information (console.log) and errors (console.error)
    // This line of code will only be executed once when your extension is activated
    console.log('Congratulations, your extension "clockwork" is now active!');

    // The command has been defined in the package.json file
    // Now provide the implementation of the command with  registerCommand
    // The commandId parameter must match the command field in package.json
    var disposable = vscode.commands.registerCommand('extension.createProject', function () {
        var thisExtension = vscode.extensions.getExtension('arcadio.clockwork');
        vscode.window.showInputBox({ prompt: "What is the name of your proyect?" }).then(function (name) {
            exec(thisExtension.extensionPath + "/node_modules/.bin/clockwork init " + name, { cwd: vscode.workspace.rootPath }, function (error, stdout, stderr) {
                if (!error) {
                    vscode.window.showInformationMessage(`Project ${name} created successfully`);
                }
            });
        })
    });
    context.subscriptions.push(disposable);

    function buildProject(callback) {
        var thisExtension = vscode.extensions.getExtension('arcadio.clockwork');
        exec(thisExtension.extensionPath + "/node_modules/.bin/clockwork build ", { cwd: vscode.workspace.rootPath }, callback);
    }

    disposable =vscode.commands.registerCommand('extension.buildProject', function () {
        buildProject(function (error, stdout, stderr) {
            if (!error) {
                vscode.window.showInformationMessage(`Project built successfully`);
            }
        });
    });
    context.subscriptions.push(disposable);

    disposable = vscode.commands.registerCommand('extension.deployPackage', function () {
        var manifest = readManifest(); ``
        if (manifest != null) {
            buildProject(function (error, stdout, stderr) {
                if (!error) {
                    // localServer.setDeployPackage(vscode.workspace.rootPath + "/"+manifest.name+".cw");
                    const opn = require('opn');
                    opn("cwrt://" + serverPort + "/deployPackage");
                }
            });
        }
    });
    context.subscriptions.push(disposable);
    

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


}
exports.activate = activate;

// this method is called when your extension is deactivated
function deactivate() {
}
exports.deactivate = deactivate;