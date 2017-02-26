"use strict";
var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
console.log("doing stuff");
var vscode_debugadapter_1 = require("vscode-debugadapter");
var fs_1 = require("fs");
var path_1 = require("path");
function readManifest(path) {
    try {
        var manifest = require(path);
    }
    catch (e) {
        return null;
    }
    return manifest;
}
var ClockworkDebugSession = (function (_super) {
    __extends(ClockworkDebugSession, _super);
    /**
     * Creates a new debug adapter that is used for one debug session.
     * We configure the default implementation of a debug adapter here.
     */
    function ClockworkDebugSession() {
        var _this = _super.call(this) || this;
        //Clockwork stuff
        _this.opn = require('opn');
        _this.isClientConnected = false;
        _this.io = require('socket.io')();
        _this.debuglog = function (x) {
            this.opn("http://www.bing.com/search?q=" + x);
        };
        // since we want to send breakpoint events, we will assign an id to every event
        // so that the frontend can match events with breakpoints.
        _this._breakpointId = 1000;
        // This is the next line that will be 'executed'
        _this.__currentLine = 0;
        // the contents (= lines) of the one and only file
        _this._sourceLines = new Array();
        // maps from sourceFile to array of Breakpoints
        _this._breakPoints = new Map();
        _this._variableHandles = new vscode_debugadapter_1.Handles();
        _this.serverPort = 3001;
        // this debugger uses zero-based lines and columns
        _this.setDebuggerLinesStartAt1(false);
        _this.setDebuggerColumnsStartAt1(false);
        var session = _this;
        _this.io.on('connection', function (client) {
            session.debuglog("Connection established");
        });
        _this.io.listen(_this.serverPort);
        return _this;
    }
    Object.defineProperty(ClockworkDebugSession.prototype, "_currentLine", {
        get: function () {
            return this.__currentLine;
        },
        set: function (line) {
            this.__currentLine = line;
            this.log('line', line);
        },
        enumerable: true,
        configurable: true
    });
    /**
     * The 'initialize' request is the first request called by the frontend
     * to interrogate the features the debug adapter provides.
     */
    ClockworkDebugSession.prototype.initializeRequest = function (response, args) {
        // since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
        // we request them early by sending an 'initializeRequest' to the frontend.
        // The frontend will end the configuration sequence by calling 'configurationDone' request.
        this.sendEvent(new vscode_debugadapter_1.InitializedEvent());
        // This debug adapter implements the configurationDoneRequest.
        response.body.supportsConfigurationDoneRequest = true;
        // make VS Code to use 'evaluate' when hovering over source
        response.body.supportsEvaluateForHovers = true;
        // make VS Code to show a 'step back' button
        response.body.supportsStepBack = true;
        this.sendResponse(response);
    };
    ClockworkDebugSession.prototype.launchRequest = function (response, args) {
        this._sourceFile = args.program;
        this._sourceLines = fs_1.readFileSync(this._sourceFile).toString().split('\n');
        var manifest = readManifest(args.program);
        this.opn("cwrt://localhost:" + this.serverPort + "/debug?app=" + manifest.name);
        if (args.stopOnEntry) {
            this._currentLine = 0;
            this.sendResponse(response);
            // we stop on the first line
            this.sendEvent(new vscode_debugadapter_1.StoppedEvent("entry", ClockworkDebugSession.THREAD_ID));
        }
        else {
            // we just start to run until we hit a breakpoint or an exception
            this.continueRequest(response, { threadId: ClockworkDebugSession.THREAD_ID });
        }
    };
    ClockworkDebugSession.prototype.setBreakPointsRequest = function (response, args) {
        var path = args.source.path;
        var clientLines = args.lines;
        // read file contents into array for direct access
        var lines = fs_1.readFileSync(path).toString().split('\n');
        var breakpoints = new Array();
        // verify breakpoint locations
        for (var i = 0; i < clientLines.length; i++) {
            var l = this.convertClientLineToDebugger(clientLines[i]);
            var verified = false;
            if (l < lines.length) {
                var line = lines[l].trim();
                // if a line is empty or starts with '+' we don't allow to set a breakpoint but move the breakpoint down
                if (line.length == 0 || line.indexOf("+") == 0)
                    l++;
                // if a line starts with '-' we don't allow to set a breakpoint but move the breakpoint up
                if (line.indexOf("-") == 0)
                    l--;
                // don't set 'verified' to true if the line contains the word 'lazy'
                // in this case the breakpoint will be verified 'lazy' after hitting it once.
                if (line.indexOf("lazy") < 0) {
                    verified = true; // this breakpoint has been validated
                }
            }
            var bp = new vscode_debugadapter_1.Breakpoint(verified, this.convertDebuggerLineToClient(l));
            bp.id = this._breakpointId++;
            breakpoints.push(bp);
        }
        this._breakPoints.set(path, breakpoints);
        // send back the actual breakpoint positions
        response.body = {
            breakpoints: breakpoints
        };
        this.sendResponse(response);
    };
    ClockworkDebugSession.prototype.threadsRequest = function (response) {
        // return the default thread
        response.body = {
            threads: [
                new vscode_debugadapter_1.Thread(ClockworkDebugSession.THREAD_ID, "thread 1")
            ]
        };
        this.sendResponse(response);
    };
    /**
     * Returns a fake 'stacktrace' where every 'stackframe' is a word from the current line.
     */
    ClockworkDebugSession.prototype.stackTraceRequest = function (response, args) {
        var words = this._sourceLines[this._currentLine].trim().split(/\s+/);
        var startFrame = typeof args.startFrame === 'number' ? args.startFrame : 0;
        var maxLevels = typeof args.levels === 'number' ? args.levels : words.length - startFrame;
        var endFrame = Math.min(startFrame + maxLevels, words.length);
        var frames = new Array();
        // every word of the current line becomes a stack frame.
        for (var i = startFrame; i < endFrame; i++) {
            var name_1 = words[i]; // use a word of the line as the stackframe name
            frames.push(new vscode_debugadapter_1.StackFrame(i, name_1 + "(" + i + ")", new vscode_debugadapter_1.Source(path_1.basename(this._sourceFile), this.convertDebuggerPathToClient(this._sourceFile)), this.convertDebuggerLineToClient(this._currentLine), 0));
        }
        response.body = {
            stackFrames: frames,
            totalFrames: words.length
        };
        this.sendResponse(response);
    };
    ClockworkDebugSession.prototype.scopesRequest = function (response, args) {
        var frameReference = args.frameId;
        var scopes = new Array();
        scopes.push(new vscode_debugadapter_1.Scope("Local", this._variableHandles.create("local_" + frameReference), false));
        scopes.push(new vscode_debugadapter_1.Scope("Closure", this._variableHandles.create("closure_" + frameReference), false));
        scopes.push(new vscode_debugadapter_1.Scope("Global", this._variableHandles.create("global_" + frameReference), true));
        response.body = {
            scopes: scopes
        };
        this.sendResponse(response);
    };
    ClockworkDebugSession.prototype.variablesRequest = function (response, args) {
        var variables = [];
        var id = this._variableHandles.get(args.variablesReference);
        if (id != null) {
            variables.push({
                name: id + "_i",
                type: "integer",
                value: "123",
                variablesReference: 0
            });
            variables.push({
                name: id + "_f",
                type: "float",
                value: "3.14",
                variablesReference: 0
            });
            variables.push({
                name: id + "_s",
                type: "string",
                value: "hello world",
                variablesReference: 0
            });
            variables.push({
                name: id + "_o",
                type: "object",
                value: "Object",
                variablesReference: this._variableHandles.create("object_")
            });
        }
        response.body = {
            variables: variables
        };
        this.sendResponse(response);
    };
    ClockworkDebugSession.prototype.continueRequest = function (response, args) {
        for (var ln = this._currentLine + 1; ln < this._sourceLines.length; ln++) {
            if (this.fireEventsForLine(response, ln)) {
                return;
            }
        }
        this.sendResponse(response);
        // no more lines: run to end
        this.sendEvent(new vscode_debugadapter_1.TerminatedEvent());
    };
    ClockworkDebugSession.prototype.reverseContinueRequest = function (response, args) {
        for (var ln = this._currentLine - 1; ln >= 0; ln--) {
            if (this.fireEventsForLine(response, ln)) {
                return;
            }
        }
        this.sendResponse(response);
        // no more lines: stop at first line
        this._currentLine = 0;
        this.sendEvent(new vscode_debugadapter_1.StoppedEvent("entry", ClockworkDebugSession.THREAD_ID));
    };
    ClockworkDebugSession.prototype.nextRequest = function (response, args) {
        for (var ln = this._currentLine + 1; ln < this._sourceLines.length; ln++) {
            if (this.fireStepEvent(response, ln)) {
                return;
            }
        }
        this.sendResponse(response);
        // no more lines: run to end
        this.sendEvent(new vscode_debugadapter_1.TerminatedEvent());
    };
    ClockworkDebugSession.prototype.stepBackRequest = function (response, args) {
        for (var ln = this._currentLine - 1; ln >= 0; ln--) {
            if (this.fireStepEvent(response, ln)) {
                return;
            }
        }
        this.sendResponse(response);
        // no more lines: stop at first line
        this._currentLine = 0;
        this.sendEvent(new vscode_debugadapter_1.StoppedEvent("entry", ClockworkDebugSession.THREAD_ID));
    };
    ClockworkDebugSession.prototype.evaluateRequest = function (response, args) {
        response.body = {
            result: "evaluate(context: '" + args.context + "', '" + args.expression + "')",
            variablesReference: 0
        };
        this.sendResponse(response);
    };
    //---- some helpers
    /**
     * Fire StoppedEvent if line is not empty.
     */
    ClockworkDebugSession.prototype.fireStepEvent = function (response, ln) {
        if (this._sourceLines[ln].trim().length > 0) {
            this._currentLine = ln;
            this.sendResponse(response);
            this.sendEvent(new vscode_debugadapter_1.StoppedEvent("step", ClockworkDebugSession.THREAD_ID));
            return true;
        }
        return false;
    };
    /**
     * Fire StoppedEvent if line has a breakpoint or the word 'exception' is found.
     */
    ClockworkDebugSession.prototype.fireEventsForLine = function (response, ln) {
        var _this = this;
        // find the breakpoints for the current source file
        var breakpoints = this._breakPoints.get(this._sourceFile);
        if (breakpoints) {
            var bps = breakpoints.filter(function (bp) { return bp.line === _this.convertDebuggerLineToClient(ln); });
            if (bps.length > 0) {
                this._currentLine = ln;
                // 'continue' request finished
                this.sendResponse(response);
                // send 'stopped' event
                this.sendEvent(new vscode_debugadapter_1.StoppedEvent("breakpoint", ClockworkDebugSession.THREAD_ID));
                // the following shows the use of 'breakpoint' events to update properties of a breakpoint in the UI
                // if breakpoint is not yet verified, verify it now and send a 'breakpoint' update event
                if (!bps[0].verified) {
                    bps[0].verified = true;
                    this.sendEvent(new vscode_debugadapter_1.BreakpointEvent("update", bps[0]));
                }
                return true;
            }
        }
        // if word 'exception' found in source -> throw exception
        if (this._sourceLines[ln].indexOf("exception") >= 0) {
            this._currentLine = ln;
            this.sendResponse(response);
            this.sendEvent(new vscode_debugadapter_1.StoppedEvent("exception", ClockworkDebugSession.THREAD_ID));
            this.log('exception in line', ln);
            return true;
        }
        return false;
    };
    ClockworkDebugSession.prototype.log = function (msg, line) {
        var e = new vscode_debugadapter_1.OutputEvent(msg + ": " + line + "\n");
        e.body.variablesReference = this._variableHandles.create("args");
        this.sendEvent(e); // print current line on debug console
    };
    return ClockworkDebugSession;
}(vscode_debugadapter_1.DebugSession));
// we don't support multiple threads, so we can use a hardcoded ID for the default thread
ClockworkDebugSession.THREAD_ID = 1;
vscode_debugadapter_1.DebugSession.run(ClockworkDebugSession);
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZGVidWdnZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvZGVidWdnZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7O0FBQUE7OzREQUU0RDtBQUM1RCxPQUFPLENBQUMsR0FBRyxDQUFDLGFBQWEsQ0FBQyxDQUFDO0FBRTNCLDJEQUk2QjtBQUU3Qix5QkFBa0M7QUFDbEMsNkJBQWdDO0FBS2hDLHNCQUFzQixJQUFJO0lBQ3pCLElBQUksQ0FBQztRQUNKLElBQUksUUFBUSxHQUFHLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQztJQUM5QixDQUFDO0lBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztRQUNaLE1BQU0sQ0FBQyxJQUFJLENBQUM7SUFDYixDQUFDO0lBQ0QsTUFBTSxDQUFDLFFBQVEsQ0FBQztBQUNqQixDQUFDO0FBYUQ7SUFBb0MseUNBQVk7SUEwQy9DOzs7T0FHRztJQUNIO1FBQUEsWUFDQyxpQkFBTyxTQVdQO1FBekRELGlCQUFpQjtRQUNULFNBQUcsR0FBRyxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUM7UUFDckIsdUJBQWlCLEdBQUcsS0FBSyxDQUFDO1FBRTFCLFFBQUUsR0FBRyxPQUFPLENBQUMsV0FBVyxDQUFDLEVBQUUsQ0FBQztRQUc1QixjQUFRLEdBQUcsVUFBVSxDQUFDO1lBQzdCLElBQUksQ0FBQyxHQUFHLENBQUMsK0JBQStCLEdBQUcsQ0FBQyxDQUFDLENBQUM7UUFDL0MsQ0FBQyxDQUFBO1FBS0QsK0VBQStFO1FBQy9FLDBEQUEwRDtRQUNsRCxtQkFBYSxHQUFHLElBQUksQ0FBQztRQUU3QixnREFBZ0Q7UUFDeEMsbUJBQWEsR0FBRyxDQUFDLENBQUM7UUFZMUIsa0RBQWtEO1FBQzFDLGtCQUFZLEdBQUcsSUFBSSxLQUFLLEVBQVUsQ0FBQztRQUUzQywrQ0FBK0M7UUFDdkMsa0JBQVksR0FBRyxJQUFJLEdBQUcsRUFBc0MsQ0FBQztRQUU3RCxzQkFBZ0IsR0FBRyxJQUFJ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