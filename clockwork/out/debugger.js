"use strict";
var __extends = (this && this.__extends) || (function () {
    var extendStatics = Object.setPrototypeOf ||
        ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
        function (d, b) { for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p]; };
    return function (d, b) {
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
var vscode_debugadapter_1 = require("vscode-debugadapter");
var fs_1 = require("fs");
var acorn = require('acorn');
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
        _this.isBackConnected = false;
        _this.isFrontConnected = false;
        _this.objectVariables = [];
        _this.engineVariables = [];
        _this.eventStack = [];
        var awaitingEvents = [];
        _this.socketEmit = function (x, y) {
            awaitingEvents.push({ x: x, y: y });
        };
        _this.pendingEval = [];
        _this.evalId = 0;
        var session = _this;
        _this.io.on('connection', function (socket) {
            awaitingEvents.forEach(function (x, y) { return socket.emit(x, y); });
            session.socketEmit = function (x, y) {
                return socket.emit(x, y);
            };
            socket.on('breakpointHit', function (data) {
                session._sourceFile = data.bp.path;
                session._currentLine = data.bp.line;
                session.objectVariables = [];
                session.engineVariables = [];
                session.eventStack = data.stack;
                for (var id in data.vars) {
                    session.objectVariables.push({ id: id, value: data.vars[id] });
                }
                for (var id in data.engineVars) {
                    session.engineVariables.push({ id: id, value: data.engineVars[id] });
                }
                session.sendEvent(new vscode_debugadapter_1.StoppedEvent("step", ClockworkDebugSession.THREAD_ID));
            });
            socket.on('continue', function (data) {
                session.sendEvent(new vscode_debugadapter_1.ContinuedEvent(ClockworkDebugSession.THREAD_ID));
            });
            socket.on('exception', function (data) {
                var e = new vscode_debugadapter_1.OutputEvent("ERROR: " + data.msg + " \n");
                session.sendEvent(e);
            });
            socket.on('log', function (data) {
                var e = new vscode_debugadapter_1.OutputEvent(data.msg + " \n");
                session.sendEvent(e);
            });
            socket.on('evalResult', function (data) {
                session.pendingEval[data.id](data.result);
            });
            session.backendConnected();
        });
        _this.io.listen(_this.serverPort);
        _this.parsedBreakpoints = new Array();
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
    ClockworkDebugSession.prototype.backendConnected = function () {
        if (!this.isBackConnected) {
            this.isBackConnected = true;
            if (this.isBackConnected && this.isFrontConnected) {
                this.sendEvent(new vscode_debugadapter_1.InitializedEvent());
            }
        }
    };
    ClockworkDebugSession.prototype.frontendConnected = function () {
        if (!this.isFrontConnected) {
            this.isFrontConnected = true;
            if (this.isBackConnected && this.isFrontConnected) {
                this.sendEvent(new vscode_debugadapter_1.InitializedEvent());
            }
        }
    };
    /**
     * The 'initialize' request is the first request called by the frontend
     * to interrogate the features the debug adapter provides.
     */
    ClockworkDebugSession.prototype.initializeRequest = function (response, args) {
        // since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
        // we request them early by sending an 'initializeRequest' to the frontend.
        // The frontend will end the configuration sequence by calling 'configurationDone' request.
        this.frontendConnected();
        // This debug adapter implements the configurationDoneRequest.
        response.body.supportsConfigurationDoneRequest = true;
        // make VS Code to use 'evaluate' when hovering over source
        response.body.supportsEvaluateForHovers = false;
        // make VS Code to show a 'step back' button
        response.body.supportsStepBack = false;
        this.sendResponse(response);
    };
    ClockworkDebugSession.prototype.launchRequest = function (response, args) {
        this._sourceFile = args.program;
        this._sourceLines = fs_1.readFileSync(this._sourceFile).toString().split('\n');
        var manifest = readManifest(args.program);
        //Find all possible breakpoints
        this.eventStepPoints = manifest.components.map(function (x) {
            var path = args.program.replace("manifest.json", manifest.scope + "/" + x);
            var parser = new ClockworkParser(fs_1.readFileSync(path).toString(), path);
            return parser.getPossibleBreakpointsFromFile();
        }).reduce(function (x, y) { return x.concat(y); });
        //Launch the app in the runtime
        this.opn("cwrt://localhost:" + this.serverPort + "/debug?app=" + manifest.name + "&levelEditor=" + (args.levelEditorEnabled || true));
        // we just start to run until we hit a breakpoint or an exception
        this.continueRequest(response, { threadId: ClockworkDebugSession.THREAD_ID });
    };
    ClockworkDebugSession.prototype.setBreakPointsRequest = function (response, args) {
        var path = args.source.path;
        var clientLines = args.lines;
        // read file contents into array for direct access
        var lines = fs_1.readFileSync(path).toString().split('\n');
        var breakpoints = new Array();
        var parser = new ClockworkParser(fs_1.readFileSync(path).toString(), path);
        // verify breakpoint locations
        for (var i = 0; i < clientLines.length; i++) {
            var l = this.convertClientLineToDebugger(clientLines[i]);
            var line = lines[l].trim();
            var cbp = parser.getComponentEvent(l);
            if (cbp) {
                l = cbp.line;
                this.parsedBreakpoints.push(cbp);
                var bp = new vscode_debugadapter_1.Breakpoint(true, this.convertDebuggerLineToClient(l));
                bp.id = this._breakpointId++;
                breakpoints.push(bp);
            }
        }
        this._breakPoints.set(path, breakpoints);
        // send back the actual breakpoint positions
        response.body = {
            breakpoints: breakpoints
        };
        this.sendResponse(response);
        this.socketEmit('setBreakpoints', this.parsedBreakpoints);
    };
    ClockworkDebugSession.prototype.threadsRequest = function (response) {
        // return the default thread
        response.body = {
            threads: [
                new vscode_debugadapter_1.Thread(ClockworkDebugSession.THREAD_ID, "Clockwork Engine Thread")
            ]
        };
        this.sendResponse(response);
    };
    ClockworkDebugSession.prototype.stackTraceRequest = function (response, args) {
        var session = this;
        var frames = this.eventStack.map(function (event, i) {
            return new vscode_debugadapter_1.StackFrame(i, event.event + " in " + event.component, new vscode_debugadapter_1.Source(session._sourceFile), session.convertDebuggerLineToClient(session._currentLine), 0);
        });
        response.body = {
            stackFrames: frames,
            totalFrames: 0
        };
        this.sendResponse(response);
    };
    ClockworkDebugSession.prototype.scopesRequest = function (response, args) {
        var frameReference = args.frameId;
        var scopes = new Array();
        scopes.push(new vscode_debugadapter_1.Scope("Object variables", this._variableHandles.create("object"), false));
        scopes.push(new vscode_debugadapter_1.Scope("Engine variables", this._variableHandles.create("engine"), true));
        response.body = {
            scopes: scopes
        };
        this.sendResponse(response);
    };
    ClockworkDebugSession.prototype.variablesRequest = function (response, args) {
        var variables;
        var id = this._variableHandles.get(args.variablesReference);
        if (id == "object") {
            variables = this.objectVariables.map(function (v, i) {
                return {
                    name: v.id,
                    type: typeof v.value,
                    value: JSON.stringify(v.value),
                    variablesReference: 0
                };
            });
        }
        if (id == "engine") {
            variables = this.engineVariables.map(function (v, i) {
                return {
                    name: v.id,
                    type: typeof v.value,
                    value: JSON.stringify(v.value),
                    variablesReference: 0
                };
            });
        }
        response.body = {
            variables: variables
        };
        this.sendResponse(response);
    };
    ClockworkDebugSession.prototype.continueRequest = function (response, args) {
        this.socketEmit('continueRequest', '');
        this.sendResponse(response);
    };
    ClockworkDebugSession.prototype.nextRequest = function (response, args) {
        this.socketEmit('stepOverRequest', '');
        this.sendResponse(response);
    };
    ClockworkDebugSession.prototype.stepInRequest = function (response, args) {
        this.socketEmit('stepInRequest', '');
        this.sendResponse(response);
    };
    ClockworkDebugSession.prototype.stepOutRequest = function (response, args) {
        this.socketEmit('stepOutRequest', '');
        this.sendResponse(response);
    };
    ClockworkDebugSession.prototype.evaluateRequest = function (response, args) {
        var session = this;
        this.socketEmit('eval', { expression: args.expression, id: this.evalId });
        this.pendingEval[this.evalId] = function (result) {
            response.body = {
                result: result,
                variablesReference: 0
            };
            session.sendResponse(response);
        };
        this.evalId++;
    };
    //---- some helpers
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
var ClockworkParser = (function () {
    function ClockworkParser(content, path) {
        var that = this;
        this.possibleBreakpoints = new Array();
        this.content = content;
        this.path = path;
        this.ast = acorn.parse(content, { locations: true });
        that.ast.body.forEach(function (expression) {
            if (expression.type == "ExpressionStatement" && expression.expression.callee.property.name == "register" && expression.expression.callee.object.property.name == "components" && expression.expression.callee.object.object.name == "CLOCKWORKRT") {
                if (expression.expression.arguments[0].type == "ArrayExpression") {
                    expression.expression.arguments[0].elements.forEach(function (component) {
                        var currentComponentName = "";
                        var currentEvents = [];
                        component.properties.forEach(function (componentProperty) {
                            if (componentProperty.key.name == "name") {
                                currentComponentName = componentProperty.value.value;
                            }
                            if (componentProperty.key.name == "events") {
                                componentProperty.value.elements.forEach(function (event) {
                                    var currentEventName = "";
                                    var currentEventPos = event.loc;
                                    event.properties.forEach(function (eventProperty) {
                                        if (eventProperty.key.name == "name") {
                                            currentEventName = eventProperty.value.value;
                                        }
                                    });
                                    currentEvents.push({ name: currentEventName, pos: currentEventPos });
                                });
                            }
                        });
                        currentEvents.forEach(function (event) {
                            that.possibleBreakpoints.push(new ClockworkBreakPoint(event.pos.start.line, currentComponentName, event.name, path));
                        });
                    });
                }
            }
        });
    }
    ClockworkParser.prototype.getPossibleBreakpointsFromFile = function () {
        return this.possibleBreakpoints;
    };
    ClockworkParser.prototype.getComponentEvent = function (n) {
        var currentBreakpoint = null;
        for (var i = 0; i < this.possibleBreakpoints.length; i++) {
            if (this.possibleBreakpoints[i].line > n) {
                break;
            }
            else {
                currentBreakpoint = this.possibleBreakpoints[i];
            }
        }
        return currentBreakpoint;
    };
    return ClockworkParser;
}());
var EventInfo = (function () {
    function EventInfo(event, eventLine) {
        this.event = event;
        this.eventLine = eventLine;
    }
    return EventInfo;
}());
var CursorPosition = (function () {
    function CursorPosition(line, character) {
        this.line = line;
        this.character = character;
    }
    CursorPosition.prototype.afterThan = function (x) {
        if (x.line == this.line) {
            return this.character > x.character;
        }
        else {
            return this.line > x.line;
        }
    };
    CursorPosition.prototype.beforeThan = function (x) {
        if (x.line == this.line) {
            return this.character < x.character;
        }
        else {
            return this.line < x.line;
        }
    };
    return CursorPosition;
}());
var ClockworkBreakPoint = (function () {
    function ClockworkBreakPoint(line, component, event, path) {
        this.line = line;
        this.component = component;
        this.event = event;
        this.path = path;
    }
    return ClockworkBreakPoint;
}());
var CLOCKWORKRT = {
    components: {
        push: function (lx) {
            CLOCKWORKRT.actualComponents = CLOCKWORKRT.actualComponents.concat(lx);
        }
    },
    actualComponents: []
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZGVidWdnZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvZGVidWdnZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7O0FBQUE7OzREQUU0RDtBQUM1RCwyREFJNkI7QUFFN0IseUJBQWtDO0FBRWxDLElBQU0sS0FBSyxHQUFHLE9BQU8sQ0FBQyxPQUFPLENBQUMsQ0FBQztBQUcvQixzQkFBc0IsSUFBSTtJQUN6QixJQUFJLENBQUM7UUFDSixJQUFJLFFBQVEsR0FBRyxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUM7SUFDOUIsQ0FBQztJQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7UUFDWixNQUFNLENBQUMsSUFBSSxDQUFDO0lBQ2IsQ0FBQztJQUNELE1BQU0sQ0FBQyxRQUFRLENBQUM7QUFDakIsQ0FBQztBQWVEO0lBQW9DLHlDQUFZO0lBc0UvQzs7O09BR0c7SUFDSDtRQUFBLFlBQ0MsaUJBQU8sU0EyRFA7UUFySUQsaUJBQWlCO1FBQ1QsU0FBRyxHQUFHLE9BQU8sQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUNyQix1QkFBaUIsR0FBRyxLQUFLLENBQUM7UUFFMUIsUUFBRSxHQUFHLE9BQU8sQ0FBQyxXQUFXLENBQUMsRUFBRSxDQUFDO1FBYXBDLCtFQUErRTtRQUMvRSwwREFBMEQ7UUFDbEQsbUJBQWEsR0FBRyxJQUFJLENBQUM7UUFFN0IsZ0RBQWdEO1FBQ3hDLG1CQUFhLEdBQUcsQ0FBQyxDQUFDO1FBWTFCLGtEQUFrRDtRQUMxQyxrQkFBWSxHQUFHLElBQUksS0FBSyxFQUFVLENBQUM7UUFFM0MsK0NBQStDO1FBQ3ZDLGtCQUFZLEdBQUcsSUFBSSxHQUFHLEVBQXNDLENBQUM7UUFHN0Qsc0JBQWdCLEdBQUcsSUFBSSw2QkFBTyxFQUFVLENBQUM7UUFFekMsZ0JBQVUsR0FBRyxJQUFJLENBQUM7UUFpQ3pCLGtEQUFrRDtRQUNsRCxLQUFJLENBQUMsd0JBQXdCLENBQUMsS0FBSyxDQUFD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