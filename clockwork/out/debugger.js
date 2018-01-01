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
var ClockworkDebugSession = /** @class */ (function (_super) {
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
        if (args.remoteMachine) {
            var dgram = require('dgram');
            var server = dgram.createSocket("udp4");
            var serverPort = this.serverPort;
            server.bind(function () {
                server.setBroadcast(true);
                server.setMulticastTTL(128);
                var message = new Buffer("debug/" + serverPort + "/" + manifest.name + "/" + args.levelEditorEnabled);
                server.send(message, 0, message.length, 8775, args.remoteMachine);
            });
        }
        else {
            this.opn("cwrt://localhost:" + this.serverPort + "/debug?app=" + manifest.name + "&levelEditor=" + (args.levelEditorEnabled || true));
        }
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
    // we don't support multiple threads, so we can use a hardcoded ID for the default thread
    ClockworkDebugSession.THREAD_ID = 1;
    return ClockworkDebugSession;
}(vscode_debugadapter_1.DebugSession));
vscode_debugadapter_1.DebugSession.run(ClockworkDebugSession);
var ClockworkParser = /** @class */ (function () {
    function ClockworkParser(content, path) {
        var that = this;
        this.possibleBreakpoints = new Array();
        this.content = content;
        this.path = path;
        this.ast = acorn.parse(content, { locations: true });
        that.ast.body.forEach(function (expression) {
            if (expression.type == "ExpressionStatement" && expression.expression.callee.property && expression.expression.callee.property.name == "register" && expression.expression.callee.object.property && expression.expression.callee.object.property.name == "components" && expression.expression.callee.object.object && expression.expression.callee.object.object.name == "CLOCKWORKRT") {
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
var EventInfo = /** @class */ (function () {
    function EventInfo(event, eventLine) {
        this.event = event;
        this.eventLine = eventLine;
    }
    return EventInfo;
}());
var CursorPosition = /** @class */ (function () {
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
var ClockworkBreakPoint = /** @class */ (function () {
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZGVidWdnZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvZGVidWdnZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7O0FBQUE7OzREQUU0RDtBQUM1RCwyREFJNkI7QUFFN0IseUJBQWtDO0FBRWxDLElBQU0sS0FBSyxHQUFHLE9BQU8sQ0FBQyxPQUFPLENBQUMsQ0FBQztBQUcvQixzQkFBc0IsSUFBSTtJQUN6QixJQUFJLENBQUM7UUFDSixJQUFJLFFBQVEsR0FBRyxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUM7SUFDOUIsQ0FBQztJQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7UUFDWixNQUFNLENBQUMsSUFBSSxDQUFDO0lBQ2IsQ0FBQztJQUNELE1BQU0sQ0FBQyxRQUFRLENBQUM7QUFDakIsQ0FBQztBQWdCRDtJQUFvQyx5Q0FBWTtJQXNFL0M7OztPQUdHO0lBQ0g7UUFBQSxZQUNDLGlCQUFPLFNBMkRQO1FBcklELGlCQUFpQjtRQUNULFNBQUcsR0FBRyxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUM7UUFDckIsdUJBQWlCLEdBQUcsS0FBSyxDQUFDO1FBRTFCLFFBQUUsR0FBRyxPQUFPLENBQUMsV0FBVyxDQUFDLEVBQUUsQ0FBQztRQWFwQywrRUFBK0U7UUFDL0UsMERBQTBEO1FBQ2xELG1CQUFhLEdBQUcsSUFBSSxDQUFDO1FBRTdCLGdEQUFnRDtRQUN4QyxtQkFBYSxHQUFHLENBQUMsQ0FBQztRQVkxQixrREFBa0Q7UUFDMUMsa0JBQVksR0FBRyxJQUFJLEtBQUssRUFBVSxDQUFDO1FBRTNDLCtDQUErQztRQUN2QyxrQkFBWSxHQUFHLElBQUksR0FBRyxFQUFzQyxDQUFDO1FBRzdELHNCQUFnQixHQUFHLElBQUksNkJBQU8sRUFBVSxDQUFDO1FBRXpDLGdCQUFVLEdBQUcsSUFBSSxDQUFDO1FBaUN6QixrREFBa0Q7UUFDbEQsS0FBSSxDQUFDLHdCQUF3QixDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQ3JDLEtBQUksQ0FBQywwQkFBMEIsQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUV2QyxLQUFJLENBQUMsZUFBZSxHQUFHLEtBQUssQ0FBQztRQUM3QixLQUFJLENBQUMsZ0JBQWdCLEdBQUcsS0FBSyxDQUFDO1FBRTlCLEtBQUksQ0FBQyxlQUFlLEdBQUcsRUFBRSxDQUFDO1FBQzFCLEtBQUksQ0FBQyxlQUFlLEdBQUcsRUFBRSxDQUFDO1FBQzFCLEtBQUksQ0FBQyxVQUFVLEdBQUcsRUFBRSxDQUFDO1FBRXJCLElBQUksY0FBYyxHQUFHLEVBQUUsQ0FBQztRQUN4QixLQUFJLENBQUMsVUFBVSxHQUFHLFVBQVUsQ0FBQyxFQUFFLENBQUM7WUFDL0IsY0FBYyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLENBQUE7UUFDcEMsQ0FBQyxDQUFDO1FBRUYsS0FBSSxDQUFDLFdBQVcsR0FBRyxFQUFFLENBQUM7UUFDdEIsS0FBSSxDQUFDLE1BQU0sR0FBRyxDQUFDLENBQUM7UUFFaEIsSUFBSSxPQUFPLEdBQUcsS0FBSSxDQUFDO1FBQ25CLEtBQUksQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLFlBQVksRUFBRSxVQUFVLE1BQU07WUFDeEMsY0FBYyxDQUFDLE9BQU8sQ0FBQyxVQUFDLENBQUMsRUFBRSxDQUFDLElBQUssT0FBQSxNQUFNLENBQUMsSUFBSSxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsRUFBakIsQ0FBaUIsQ0FBQyxDQUFDO1lBQ3BELE9BQU8sQ0FBQyxVQUFVLEdBQUcsVUFBVSxDQUFDLEVBQUUsQ0FBQztnQkFDbEMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDO1lBQzFCLENBQUMsQ0FBQTtZQUNELE1BQU0sQ0FBQyxFQUFFLENBQUMsZUFBZSxFQUFFLFVBQVUsSUFBSTtnQkFDeEMsT0FBTyxDQUFDLFdBQVcsR0FBRyxJQUFJLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQztnQkFDbkMsT0FBTyxDQUFDLFlBQVksR0FBRyxJQUFJLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQztnQkFDcEMsT0FBTyxDQUFDLGVBQWUsR0FBRyxFQUFFLENBQUM7Z0JBQzdCLE9BQU8sQ0FBQyxlQUFlLEdBQUcsRUFBRSxDQUFDO2dCQUM3QixPQUFPLENBQUMsVUFBVSxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUM7Z0JBQ2hDLEdBQUcsQ0FBQyxDQUFDLElBQUksRUFBRSxJQUFJLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDO29CQUMxQixPQUFPLENBQUMsZUFBZSxDQUFDLElBQUksQ0FBQyxFQUFFLEVBQUUsRUFBRSxFQUFFLEVBQUUsS0FBSyxFQUFFLElBQUksQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxDQUFDO2dCQUNoRSxDQUFDO2dCQUNELEdBQUcsQ0FBQyxDQUFDLElBQUksRUFBRSxJQUFJLElBQUksQ0FBQyxVQUFVLENBQUMsQ0FBQyxDQUFDO29CQUNoQyxPQUFPLENBQUMsZUFBZSxDQUFDLElBQUksQ0FBQyxFQUFFLEVBQUUsRUFBRSxFQUFFLEVBQUUsS0FBSyxFQUFFLElBQUksQ0FBQyxVQUFVLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxDQUFDO2dCQUN0RSxDQUFDO2dCQUNELE9BQU8sQ0FBQyxTQUFTLENBQUMsSUFBSSxrQ0FBWSxDQUFDLE1BQU0sRUFBRSxxQkFBcUIsQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDO1lBQzlFLENBQUMsQ0FBQyxDQUFDO1lBQ0gsTUFBTSxDQUFDLEVBQUUsQ0FBQyxVQUFVLEVBQUUsVUFBVSxJQUFJO2dCQUNuQyxPQUFPLENBQUMsU0FBUyxDQUFDLElBQUksb0NBQWMsQ0FBQyxxQkFBcUIsQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDO1lBQ3hFLENBQUMsQ0FBQyxDQUFDO1lBQ0gsTUFBTSxDQUFDLEVBQUUsQ0FBQyxXQUFXLEVBQUUsVUFBVSxJQUFJO2dCQUNwQyxJQUFNLENBQUMsR0FBRyxJQUFJLGlDQUFXLENBQUMsWUFBVSxJQUFJLENBQUMsR0FBRyxRQUFLLENBQUMsQ0FBQztnQkFDbkQsT0FBTyxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsQ0FBQztZQUN0QixDQUFDLENBQUMsQ0FBQztZQUNILE1BQU0sQ0FBQyxFQUFFLENBQUMsS0FBSyxFQUFFLFVBQVUsSUFBSTtnQkFDOUIsSUFBTSxDQUFDLEdBQUcsSUFBSSxpQ0FBVyxDQUFJLElBQUksQ0FBQyxHQUFHLFFBQUssQ0FBQyxDQUFDO2dCQUM1QyxPQUFPLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxDQUFDO1lBQ3RCLENBQUMsQ0FBQyxDQUFDO1lBQ0gsTUFBTSxDQUFDLEVBQUUsQ0FBQyxZQUFZLEVBQUUsVUFBVSxJQUFJO2dCQUNyQyxPQUFPLENBQUMsV0FBVyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLENBQUM7WUFDM0MsQ0FBQyxDQUFDLENBQUM7WUFDSCxPQUFPLENBQUMsZ0JBQWdCLEVBQUUsQ0FBQztRQUM1QixDQUFDLENBQUMsQ0FBQztRQUNILEtBQUksQ0FBQyxFQUFFLENBQUMsTUFBTSxDQUFDLEtBQUksQ0FBQyxVQUFVLENBQUMsQ0FBQztRQUNoQyxLQUFJLENBQUMsaUJBQWlCLEdBQUcsSUFBSSxLQUFLLEVBQXVCLENBQUM7O0lBQzNELENBQUM7SUE5R0Qsc0JBQVksK0NBQVk7YUFBeEI7WUFDQyxNQUFNLENBQUMsSUFBSSxDQUFDLGFBQWEsQ0FBQztRQUMzQixDQUFDO2FBQ0QsVUFBeUIsSUFBWTtZQUNwQyxJQUFJLENBQUMsYUFBYSxHQUFHLElBQUksQ0FBQztZQUMxQixJQUFJLENBQUMsR0FBRyxDQUFDLE1BQU0sRUFBRSxJQUFJLENBQUMsQ0FBQztRQUN4QixDQUFDOzs7T0FKQTtJQTJCTyxnREFBZ0IsR0FBeEI7UUFDQyxFQUFFLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxlQUFlLENBQUMsQ0FBQyxDQUFDO1lBQzNCLElBQUksQ0FBQyxlQUFlLEdBQUcsSUFBSSxDQUFDO1lBQzVCLEVBQUUsQ0FBQyxDQUFDLElBQUksQ0FBQyxlQUFlLElBQUksSUFBSSxDQUFDLGdCQUFnQixDQUFDLENBQUMsQ0FBQztnQkFDbkQsSUFBSSxDQUFDLFNBQVMsQ0FBQyxJQUFJLHNDQUFnQixFQUFFLENBQUMsQ0FBQztZQUN4QyxDQUFDO1FBQ0YsQ0FBQztJQUNGLENBQUM7SUFFTyxpREFBaUIsR0FBekI7UUFDQyxFQUFFLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxnQkFBZ0IsQ0FBQyxDQUFDLENBQUM7WUFDNUIsSUFBSSxDQUFDLGdCQUFnQixHQUFHLElBQUksQ0FBQztZQUM3QixFQUFFLENBQUMsQ0FBQyxJQUFJLENBQUMsZUFBZSxJQUFJLElBQUksQ0FBQyxnQkFBZ0IsQ0FBQyxDQUFDLENBQUM7Z0JBQ25ELElBQUksQ0FBQyxTQUFTLENBQUMsSUFBSSxzQ0FBZ0IsRUFBRSxDQUFDLENBQUM7WUFDeEMsQ0FBQztRQUNGLENBQUM7SUFDRixDQUFDO0lBbUVEOzs7T0FHRztJQUNPLGlEQUFpQixHQUEzQixVQUE0QixRQUEwQyxFQUFFLElBQThDO1FBRXJILCtGQUErRjtRQUMvRiwyRUFBMkU7UUFDM0UsMkZBQTJGO1FBQzNGLElBQUksQ0FBQyxpQkFBaUIsRUFBRSxDQUFDO1FBRXpCLDhEQUE4RDtRQUM5RCxRQUFRLENBQUMsSUFBSSxDQUFDLGdDQUFnQyxHQUFHLElBQUksQ0FBQztRQUV0RCwyREFBMkQ7UUFDM0QsUUFBUSxDQUFDLElBQUksQ0FBQyx5QkFBeUIsR0FBRyxLQUFLLENBQUM7UUFFaEQsNENBQTRDO1FBQzVDLFFBQVEsQ0FBQyxJQUFJLENBQUMsZ0JBQWdCLEdBQUcsS0FBSyxDQUFDO1FBRXZDLElBQUksQ0FBQyxZQUFZLENBQUMsUUFBUSxDQUFDLENBQUM7SUFDN0IsQ0FBQztJQUVTLDZDQUFhLEdBQXZCLFVBQXdCLFFBQXNDLEVBQUUsSUFBNEI7UUFDM0YsSUFBSSxDQUFDLFdBQVcsR0FBRyxJQUFJLENBQUMsT0FBTyxDQUFDO1FBQ2hDLElBQUksQ0FBQyxZQUFZLEdBQUcsaUJBQVksQ0FBQyxJQUFJLENBQUMsV0FBVyxDQUFDLENBQUMsUUFBUSxFQUFFLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFDO1FBQzFFLElBQUksUUFBUSxHQUFHLFlBQVksQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLENBQUM7UUFDMUMsK0JBQStCO1FBRS9CLElBQUksQ0FBQyxlQUFlLEdBQUcsUUFBUSxDQUFDLFVBQVUsQ0FBQyxHQUFHLENBQUMsVUFBVSxDQUFDO1lBQ3pELElBQUksSUFBSSxHQUFHLElBQUksQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLGVBQWUsRUFBRSxRQUFRLENBQUMsS0FBSyxHQUFHLEdBQUcsR0FBRyxDQUFDLENBQUMsQ0FBQztZQUMzRSxJQUFJLE1BQU0sR0FBRyxJQUFJLGVBQWUsQ0FBQyxpQkFBWSxDQUFDLElBQUksQ0FBQyxDQUFDLFFBQVEsRUFBRSxFQUFFLElBQUksQ0FBQyxDQUFDO1lBQ3RFLE1BQU0sQ0FBQyxNQUFNLENBQUMsOEJBQThCLEVBQUUsQ0FBQztRQUNoRCxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsVUFBVSxDQUFDLEVBQUUsQ0FBQyxJQUFJLE1BQU0sQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7UUFDbkQsK0JBQStCO1FBQy9CLEVBQUUsQ0FBQyxDQUFDLElBQUksQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDO1lBQ3hCLElBQUksS0FBSyxHQUFHLE9BQU8sQ0FBQyxPQUFPLENBQUMsQ0FBQztZQUM3QixJQUFJLE1BQU0sR0FBRyxLQUFLLENBQUMsWUFBWSxDQUFDLE1BQU0sQ0FBQyxDQUFDO1lBQ3hDLElBQUksVUFBVSxHQUFHLElBQUksQ0FBQyxVQUFVLENBQUM7WUFDakMsTUFBTSxDQUFDLElBQUksQ0FBQztnQkFDWCxNQUFNLENBQUMsWUFBWSxDQUFDLElBQUksQ0FBQyxDQUFBO2dCQUN6QixNQUFNLENBQUMsZUFBZSxDQUFDLEdBQUcsQ0FBQyxDQUFDO2dCQUM1QixJQUFJLE9BQU8sR0FBRyxJQUFJLE1BQU0sQ0FBQyxRQUFRLEdBQUcsVUFBVSxHQUFHLEdBQUcsR0FBRyxRQUFRLENBQUMsSUFBSSxHQUFHLEdBQUcsR0FBRyxJQUFJLENBQUMsa0JBQWtCLENBQUMsQ0FBQztnQkFDdEcsTUFBTSxDQUFDLElBQUksQ0FBQyxPQUFPLEVBQUUsQ0FBQyxFQUFFLE9BQU8sQ0FBQyxNQUFNLEVBQUUsSUFBSSxFQUFFLElBQUksQ0FBQyxhQUFhLENBQUMsQ0FBQztZQUNuRSxDQUFDLENBQUMsQ0FBQztRQUNKLENBQUM7UUFBQyxJQUFJLENBQUMsQ0FBQztZQUNQLElBQUksQ0FBQyxHQUFHLENBQUMsbUJBQW1CLEdBQUcsSUFBSSxDQUFDLFVBQVUsR0FBRyxhQUFhLEdBQUcsUUFBUSxDQUFDLElBQUksR0FBRyxlQUFlLEdBQUcsQ0FBQyxJQUFJLENBQUMsa0JBQWtCLElBQUksSUFBSSxDQUFDLENBQUMsQ0FBQztRQUN2SSxDQUFDO1FBRUQsaUVBQWlFO1FBQ2pFLElBQUksQ0FBQyxlQUFlLENBQWlDLFFBQVEsRUFBRSxFQUFFLFFBQVEsRUFBRSxxQkFBcUIsQ0FBQyxTQUFTLEVBQUUsQ0FBQyxDQUFDO0lBQy9HLENBQUM7SUFFUyxxREFBcUIsR0FBL0IsVUFBZ0MsUUFBOEMsRUFBRSxJQUEyQztRQUUxSCxJQUFJLElBQUksR0FBRyxJQUFJLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQztRQUM1QixJQUFJLFdBQVcsR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDO1FBQzdCLGtEQUFrRDtRQUNsRCxJQUFJLEtBQUssR0FBRyxpQkFBWSxDQUFDLElBQUksQ0FBQyxDQUFDLFFBQVEsRUFBRSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUV0RCxJQUFJLFdBQVcsR0FBRyxJQUFJLEtBQUssRUFBYyxDQUFDO1FBRTFDLElBQUksTUFBTSxHQUFHLElBQUksZUFBZSxDQUFDLGlCQUFZLENBQUMsSUFBSSxDQUFDLENBQUMsUUFBUSxFQUFFLEVBQUUsSUFBSSxDQUFDLENBQUM7UUFFdEUsOEJBQThCO1FBQzlCLEdBQUcsQ0FBQyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLEdBQUcsV0FBVyxDQUFDLE1BQU0sRUFBRSxDQUFDLEVBQUUsRUFBRSxDQUFDO1lBQzdDLElBQUksQ0FBQyxHQUFHLElBQUksQ0FBQywyQkFBMkIsQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztZQUN6RCxJQUFNLElBQUksR0FBRyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUM7WUFDN0IsSUFBSSxHQUFHLEdBQUcsTUFBTSxDQUFDLGlCQUFpQixDQUFDLENBQUMsQ0FBQyxDQUFDO1lBQ3RDLEVBQUUsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUM7Z0JBQ1QsQ0FBQyxHQUFHLEdBQUcsQ0FBQyxJQUFJLENBQUM7Z0JBQ2IsSUFBSSxDQUFDLGlCQUFpQixDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQztnQkFDakMsSUFBTSxFQUFFLEdBQTZCLElBQUksZ0NBQVUsQ0FBQyxJQUFJLEVBQUUsSUFBSSxDQUFDLDJCQUEyQixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7Z0JBQy9GLEVBQUUsQ0FBQyxFQUFFLEdBQUcsSUFBSSxDQUFDLGFBQWEsRUFBRSxDQUFDO2dCQUM3QixXQUFXLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxDQUFDO1lBQ3RCLENBQUM7UUFDRixDQUFDO1FBQ0QsSUFBSSxDQUFDLFlBQVksQ0FBQyxHQUFHLENBQUMsSUFBSSxFQUFFLFdBQVcsQ0FBQyxDQUFDO1FBRXpDLDRDQUE0QztRQUM1QyxRQUFRLENBQUMsSUFBSSxHQUFHO1lBQ2YsV0FBVyxFQUFFLFdBQVc7U0FDeEIsQ0FBQztRQUNGLElBQUksQ0FBQyxZQUFZLENBQUMsUUFBUSxDQUFDLENBQUM7UUFFNUIsSUFBSSxDQUFDLFVBQVUsQ0FBQyxnQkFBZ0IsRUFBRSxJQUFJLENBQUMsaUJBQWlCLENBQUMsQ0FBQztJQUMzRCxDQUFDO0lBRVMsOENBQWMsR0FBeEIsVUFBeUIsUUFBdUM7UUFDL0QsNEJBQTRCO1FBQzVCLFFBQVEsQ0FBQyxJQUFJLEdBQUc7WUFDZixPQUFPLEVBQUU7Z0JBQ1IsSUFBSSw0QkFBTSxDQUFDLHFCQUFxQixDQUFDLFNBQVMsRUFBRSx5QkFBeUIsQ0FBQzthQUN0RTtTQUNELENBQUM7UUFDRixJQUFJLENBQUMsWUFBWSxDQUFDLFFBQVEsQ0FBQyxDQUFDO0lBQzdCLENBQUM7SUFFUyxpREFBaUIsR0FBM0IsVUFBNEIsUUFBMEMsRUFBRSxJQUF1QztRQUM5RyxJQUFJLE9BQU8sR0FBRyxJQUFJLENBQUM7UUFDbkIsSUFBTSxNQUFNLEdBQUcsSUFBSSxDQUFDLFVBQVUsQ0FBQyxHQUFHLENBQUMsVUFBVSxLQUFLLEVBQUUsQ0FBQztZQUNwRCxNQUFNLENBQUMsSUFBSSxnQ0FBVSxDQUFDLENBQUMsRUFBSyxLQUFLLENBQUMsS0FBSyxZQUFPLEtBQUssQ0FBQyxTQUFXLEVBQUUsSUFBSSw0QkFBTSxDQUFDLE9BQU8sQ0FBQyxXQUFXLENBQUMsRUFBRSxPQUFPLENBQUMsMkJBQTJCLENBQUMsT0FBTyxDQUFDLFlBQVksQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDO1FBQ2pLLENBQUMsQ0FBQyxDQUFDO1FBQ0gsUUFBUSxDQUFDLElBQUksR0FBRztZQUNmLFdBQVcsRUFBRSxNQUFNO1lBQ25CLFdBQVcsRUFBRSxDQUFDO1NBQ2QsQ0FBQztRQUNGLElBQUksQ0FBQyxZQUFZLENBQUMsUUFBUSxDQUFDLENBQUM7SUFDN0IsQ0FBQztJQUVTLDZDQUFhLEdBQXZCLFVBQXdCLFFBQXNDLEVBQUUsSUFBbUM7UUFFbEcsSUFBTSxjQUFjLEdBQUcsSUFBSSxDQUFDLE9BQU8sQ0FBQztRQUNwQyxJQUFNLE1BQU0sR0FBRyxJQUFJLEtBQUssRUFBUyxDQUFDO1FBQ2xDLE1BQU0sQ0FBQyxJQUFJLENBQUMsSUFBSSwyQkFBSyxDQUFDLGtCQUFrQixFQUFFLElBQUksQ0FBQyxnQkFBZ0IsQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLEVBQUUsS0FBSyxDQUFDLENBQUMsQ0FBQztRQUMxRixNQUFNLENBQUMsSUFBSSxDQUFDLElBQUksMkJBQUssQ0FBQyxrQkFBa0IsRUFBRSxJQUFJLENBQUMsZ0JBQWdCLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQyxFQUFFLElBQUksQ0FBQyxDQUFDLENBQUM7UUFFekYsUUFBUSxDQUFDLElBQUksR0FBRztZQUNmLE1BQU0sRUFBRSxNQUFNO1NBQ2QsQ0FBQztRQUNGLElBQUksQ0FBQyxZQUFZLENBQUMsUUFBUSxDQUFDLENBQUM7SUFDN0IsQ0FBQztJQUVTLGdEQUFnQixHQUExQixVQUEyQixRQUF5QyxFQUFFLElBQXNDO1FBQzNHLElBQUksU0FBUyxDQUFDO1FBQ2QsSUFBTSxFQUFFLEdBQUcsSUFBSSxDQUFDLGdCQUFnQixDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsa0JBQWtCLENBQUMsQ0FBQztRQUM5RCxFQUFFLENBQUMsQ0FBQyxFQUFFLElBQUksUUFBUSxDQUFDLENBQUMsQ0FBQztZQUNwQixTQUFTLEdBQUcsSUFBSSxDQUFDLGVBQWUsQ0FBQyxHQUFHLENBQUMsVUFBVSxDQUFDLEVBQUUsQ0FBQztnQkFDbEQsTUFBTSxDQUFDO29CQUNOLElBQUksRUFBRSxDQUFDLENBQUMsRUFBRTtvQkFDVixJQUFJLEVBQUUsT0FBTyxDQUFDLENBQUMsS0FBSztvQkFDcEIsS0FBSyxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQztvQkFDOUIsa0JBQWtCLEVBQUUsQ0FBQztpQkFDckIsQ0FBQztZQUNILENBQUMsQ0FBQyxDQUFDO1FBQ0osQ0FBQztRQUNELEVBQUUsQ0FBQyxDQUFDLEVBQUUsSUFBSSxRQUFRLENBQUMsQ0FBQyxDQUFDO1lBQ3BCLFNBQVMsR0FBRyxJQUFJLENBQUMsZUFBZSxDQUFDLEdBQUcsQ0FBQyxVQUFVLENBQUMsRUFBRSxDQUFDO2dCQUNsRCxNQUFNLENBQUM7b0JBQ04sSUFBSSxFQUFFLENBQUMsQ0FBQyxFQUFFO29CQUNWLElBQUksRUFBRSxPQUFPLENBQUMsQ0FBQyxLQUFLO29CQUNwQixLQUFLLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDO29CQUM5QixrQkFBa0IsRUFBRSxDQUFDO2lCQUNyQixDQUFDO1lBQ0gsQ0FBQyxDQUFDLENBQUM7UUFDSixDQUFDO1FBRUQsUUFBUSxDQUFDLElBQUksR0FBRztZQUNmLFNBQVMsRUFBRSxTQUFTO1NBQ3BCLENBQUM7UUFDRixJQUFJLENBQUMsWUFBWSxDQUFDLFFBQVEsQ0FBQyxDQUFDO0lBQzdCLENBQUM7SUFFUywrQ0FBZSxHQUF6QixVQUEwQixRQUF3QyxFQUFFLElBQXFDO1FBQ3hHLElBQUksQ0FBQyxVQUFVLENBQUMsaUJBQWlCLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFFdkMsSUFBSSxDQUFDLFlBQVksQ0FBQyxRQUFRLENBQUMsQ0FBQztJQUM3QixDQUFDO0lBRVMsMkNBQVcsR0FBckIsVUFBc0IsUUFBb0MsRUFBRSxJQUFpQztRQUM1RixJQUFJLENBQUMsVUFBVSxDQUFDLGlCQUFpQixFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBQ3ZDLElBQUksQ0FBQyxZQUFZLENBQUMsUUFBUSxDQUFDLENBQUM7SUFDN0IsQ0FBQztJQUVTLDZDQUFhLEdBQXZCLFVBQXdCLFFBQXNDLEVBQUUsSUFBbUM7UUFDbEcsSUFBSSxDQUFDLFVBQVUsQ0FBQyxlQUFlLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFDckMsSUFBSSxDQUFDLFlBQVksQ0FBQyxRQUFRLENBQUMsQ0FBQztJQUM3QixDQUFDO0lBQ1MsOENBQWMsR0FBeEIsVUFBeUIsUUFBdUMsRUFBRSxJQUFvQztRQUNyRyxJQUFJLENBQUMsVUFBVSxDQUFDLGdCQUFnQixFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBQ3RDLElBQUksQ0FBQyxZQUFZLENBQUMsUUFBUSxDQUFDLENBQUM7SUFDN0IsQ0FBQztJQUdTLCtDQUFlLEdBQXpCLFVBQTBCLFFBQXdDLEVBQUUsSUFBcUM7UUFDeEcsSUFBSSxPQUFPLEdBQUcsSUFBSSxDQUFDO1FBQ25CLElBQUksQ0FBQyxVQUFVLENBQUMsTUFBTSxFQUFFLEVBQUUsVUFBVSxFQUFFLElBQUksQ0FBQyxVQUFVLEVBQUUsRUFBRSxFQUFFLElBQUksQ0FBQyxNQUFNLEVBQUUsQ0FBQyxDQUFDO1FBQzFFLElBQUksQ0FBQyxXQUFXLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxHQUFHLFVBQVUsTUFBTTtZQUMvQyxRQUFRLENBQUMsSUFBSSxHQUFHO2dCQUNmLE1BQU0sRUFBRSxNQUFNO2dCQUNkLGtCQUFrQixFQUFFLENBQUM7YUFDckIsQ0FBQztZQUNGLE9BQU8sQ0FBQyxZQUFZLENBQUMsUUFBUSxDQUFDLENBQUM7UUFDaEMsQ0FBQyxDQUFBO1FBQ0QsSUFBSSxDQUFDLE1BQU0sRUFBRSxDQUFDO0lBQ2YsQ0FBQztJQUVELG1CQUFtQjtJQUVYLG1DQUFHLEdBQVgsVUFBWSxHQUFXLEVBQUUsSUFBWTtRQUNwQyxJQUFNLENBQUMsR0FBRyxJQUFJLGlDQUFXLENBQUksR0FBRyxVQUFLLElBQUksT0FBSSxDQUFDLENBQUM7UUFDbkIsQ0FBRSxDQUFDLElBQUksQ0FBQyxrQkFBa0IsR0FBRyxJQUFJLENBQUMsZ0JBQWdCLENBQUMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxDQUFDO1FBQzlGLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxzQ0FBc0M7SUFDMUQsQ0FBQztJQTFURCx5RkFBeUY7SUFDMUUsK0JBQVMsR0FBRyxDQUFDLENBQUM7SUEwVDlCLDRCQUFDO0NBQUEsQUExVUQsQ0FBb0Msa0NBQVksR0EwVS9DO0FBRUQsa0NBQVksQ0FBQyxHQUFHLENBQUMscUJBQXFCLENBQUMsQ0FBQztBQUV4QztJQU9DLHlCQUFtQixPQUFPLEVBQUUsSUFBSTtRQUMvQixJQUFJLElBQUksR0FBRyxJQUFJLENBQUM7UUFDaEIsSUFBSSxDQUFDLG1CQUFtQixHQUFHLElBQUksS0FBSyxFQUF1QixDQUFDO1FBQzVELElBQUksQ0FBQyxPQUFPLEdBQUcsT0FBTyxDQUFDO1FBQ3ZCLElBQUksQ0FBQyxJQUFJLEdBQUcsSUFBSSxDQUFDO1FBQ2pCLElBQUksQ0FBQyxHQUFHLEdBQUcsS0FBSyxDQUFDLEtBQUssQ0FBQyxPQUFPLEVBQUUsRUFBRSxTQUFTLEVBQUUsSUFBSSxFQUFFLENBQUMsQ0FBQztRQUNyRCxJQUFJLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsVUFBVSxVQUFVO1lBQ3pDLEVBQUUsQ0FBQyxDQUFDLFVBQVUsQ0FBQyxJQUFJLElBQUkscUJBQXFCLElBQUksVUFBVSxDQUFDLFVBQVUsQ0FBQyxNQUFNLENBQUMsUUFBUSxJQUFJLFVBQVUsQ0FBQyxVQUFVLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQyxJQUFJLElBQUksVUFBVSxJQUFJLFVBQVUsQ0FBQyxVQUFVLENBQUMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxRQUFRLElBQUksVUFBVSxDQUFDLFVBQVUsQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQyxJQUFJLElBQUksWUFBWSxJQUFJLFVBQVUsQ0FBQyxVQUFVLENBQUMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxNQUFNLElBQUksVUFBVSxDQUFDLFVBQVUsQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxJQUFJLElBQUksYUFBYSxDQUFDLENBQUMsQ0FBQztnQkFDMVgsRUFBRSxDQUFDLENBQUMsVUFBVSxDQUFDLFVBQVUsQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxJQUFJLGlCQUFpQixDQUFDLENBQUMsQ0FBQztvQkFDbEUsVUFBVSxDQUFDLFVBQVUsQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLE9BQU8sQ0FBQyxVQUFVLFNBQVM7d0JBQ3RFLElBQUksb0JBQW9CLEdBQUcsRUFBRSxDQUFDO3dCQUM5QixJQUFJLGFBQWEsR0FBRyxFQUFFLENBQUM7d0JBQ3ZCLFNBQVMsQ0FBQyxVQUFVLENBQUMsT0FBTyxDQUFDLFVBQVUsaUJBQWlCOzRCQUN2RCxFQUFFLENBQUMsQ0FBQyxpQkFBaUIsQ0FBQyxHQUFHLENBQUMsSUFBSSxJQUFJLE1BQU0sQ0FBQyxDQUFDLENBQUM7Z0NBQzFDLG9CQUFvQixHQUFHLGlCQUFpQixDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUM7NEJBQ3RELENBQUM7NEJBQ0QsRUFBRSxDQUFDLENBQUMsaUJBQWlCLENBQUMsR0FBRyxDQUFDLElBQUksSUFBSSxRQUFRLENBQUMsQ0FBQyxDQUFDO2dDQUM1QyxpQkFBaUIsQ0FBQyxLQUFLLENBQUMsUUFBUSxDQUFDLE9BQU8sQ0FBQyxVQUFVLEtBQUs7b0NBQ3ZELElBQUksZ0JBQWdCLEdBQUcsRUFBRSxDQUFDO29DQUMxQixJQUFJLGVBQWUsR0FBRyxLQUFLLENBQUMsR0FBRyxDQUFDO29DQUNoQyxLQUFLLENBQUMsVUFBVSxDQUFDLE9BQU8sQ0FBQyxVQUFVLGFBQWE7d0NBQy9DLEVBQUUsQ0FBQyxDQUFDLGFBQWEsQ0FBQyxHQUFHLENBQUMsSUFBSSxJQUFJLE1BQU0sQ0FBQyxDQUFDLENBQUM7NENBQ3RDLGdCQUFnQixHQUFHLGFBQWEsQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDO3dDQUM5QyxDQUFDO29DQUNGLENBQUMsQ0FBQyxDQUFDO29DQUNILGFBQWEsQ0FBQyxJQUFJLENBQUMsRUFBRSxJQUFJLEVBQUUsZ0JBQWdCLEVBQUUsR0FBRyxFQUFFLGVBQWUsRUFBRSxDQUFDLENBQUM7Z0NBQ3RFLENBQUMsQ0FBQyxDQUFDOzRCQUNKLENBQUM7d0JBQ0YsQ0FBQyxDQUFDLENBQUM7d0JBQ0gsYUFBYSxDQUFDLE9BQU8sQ0FBQyxVQUFVLEtBQUs7NEJBQ3BDLElBQUksQ0FBQyxtQkFBbUIsQ0FBQyxJQUFJLENBQUMsSUFBSSxtQkFBbUIsQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxJQUFJLEVBQUUsb0JBQW9CLEVBQUUsS0FBSyxDQUFDLElBQUksRUFBRSxJQUFJLENBQUMsQ0FBQyxDQUFDO3dCQUN0SCxDQUFDLENBQUMsQ0FBQztvQkFDSixDQUFDLENBQUMsQ0FBQztnQkFDSixDQUFDO1lBQ0YsQ0FBQztRQUNGLENBQUMsQ0FBQyxDQUFDO0lBQ0osQ0FBQztJQUNNLHdEQUE4QixHQUFyQztRQUNDLE1BQU0sQ0FBQyxJQUFJLENBQUMsbUJBQW1CLENBQUM7SUFDakMsQ0FBQztJQUVNLDJDQUFpQixHQUF4QixVQUF5QixDQUFTO1FBQ2pDLElBQUksaUJBQWlCLEdBQUcsSUFBSSxDQUFDO1FBQzdCLEdBQUcsQ0FBQyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLEdBQUcsSUFBSSxDQUFDLG1CQUFtQixDQUFDLE1BQU0sRUFBRSxDQUFDLEVBQUUsRUFBRSxDQUFDO1lBQzFELEVBQUUsQ0FBQyxDQUFDLElBQUksQ0FBQyxtQkFBbUIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQztnQkFDMUMsS0FBSyxDQUFDO1lBQ1AsQ0FBQztZQUFDLElBQUksQ0FBQyxDQUFDO2dCQUNQLGlCQUFpQixHQUFHLElBQUksQ0FBQyxtQkFBbUIsQ0FBQyxDQUFDLENBQUMsQ0FBQztZQUNqRCxDQUFDO1FBQ0YsQ0FBQztRQUNELE1BQU0sQ0FBQyxpQkFBaUIsQ0FBQztJQUMxQixDQUFDO0lBQ0Ysc0JBQUM7QUFBRCxDQUFDLEFBM0RELElBMkRDO0FBR0Q7SUFHQyxtQkFBbUIsS0FBYSxFQUFFLFNBQWlCO1FBQ2xELElBQUksQ0FBQyxLQUFLLEdBQUcsS0FBSyxDQUFDO1FBQ25CLElBQUksQ0FBQyxTQUFTLEdBQUcsU0FBUyxDQUFDO0lBQzVCLENBQUM7SUFDRixnQkFBQztBQUFELENBQUMsQUFQRCxJQU9DO0FBRUQ7SUFHQyx3QkFBbUIsSUFBWSxFQUFFLFNBQWlCO1FBQ2pELElBQUksQ0FBQyxJQUFJLEdBQUcsSUFBSSxDQUFDO1FBQ2pCLElBQUksQ0FBQyxTQUFTLEdBQUcsU0FBUyxDQUFDO0lBQzVCLENBQUM7SUFDTSxrQ0FBUyxHQUFoQixVQUFpQixDQUFpQjtRQUNqQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxJQUFJLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDO1lBQ3pCLE1BQU0sQ0FBQyxJQUFJLENBQUMsU0FBUyxHQUFHLENBQUMsQ0FBQyxTQUFTLENBQUM7UUFDckMsQ0FBQztRQUFDLElBQUksQ0FBQyxDQUFDO1lBQ1AsTUFBTSxDQUFDLElBQUksQ0FBQyxJQUFJLEdBQUcsQ0FBQyxDQUFDLElBQUksQ0FBQztRQUMzQixDQUFDO0lBQ0YsQ0FBQztJQUNNLG1DQUFVLEdBQWpCLFVBQWtCLENBQWlCO1FBQ2xDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLElBQUksSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUM7WUFDekIsTUFBTSxDQUFDLElBQUksQ0FBQyxTQUFTLEdBQUcsQ0FBQyxDQUFDLFNBQVMsQ0FBQztRQUNyQyxDQUFDO1FBQUMsSUFBSSxDQUFDLENBQUM7WUFDUCxNQUFNLENBQUMsSUFBSSxDQUFDLElBQUksR0FBRyxDQUFDLENBQUMsSUFBSSxDQUFDO1FBQzNCLENBQUM7SUFDRixDQUFDO0lBQ0YscUJBQUM7QUFBRCxDQUFDLEFBckJELElBcUJDO0FBRUQ7SUFLQyw2QkFBbUIsSUFBWSxFQUFFLFNBQWlCLEVBQUUsS0FBYSxFQUFFLElBQVk7UUFDOUUsSUFBSSxDQUFDLElBQUksR0FBRyxJQUFJLENBQUM7UUFDakIsSUFBSSxDQUFDLFNBQVMsR0FBRyxTQUFTLENBQUM7UUFDM0IsSUFBSSxDQUFDLEtBQUssR0FBRyxLQUFLLENBQUM7UUFDbkIsSUFBSSxDQUFDLElBQUksR0FBRyxJQUFJLENBQUM7SUFDbEIsQ0FBQztJQUNGLDBCQUFDO0FBQUQsQ0FBQyxBQVhELElBV0M7QUFFRCxJQUFJLFdBQVcsR0FBRztJQUNqQixVQUFVLEVBQUU7UUFDWCxJQUFJLEVBQUUsVUFBVSxFQUFFO1lBQ2pCLFdBQVcsQ0FBQyxnQkFBZ0IsR0FBRyxXQUFXLENBQUMsZ0JBQWdCLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQyxDQUFDO1FBQ3hFLENBQUM7S0FDRDtJQUNELGdCQUFnQixFQUFFLEVBQUU7Q0FDcEIsQ0FBQyJ9