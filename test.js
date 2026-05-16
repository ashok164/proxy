const WebSocket = require("ws");

const ws = new WebSocket("ws://82.29.155.252:3000/ws/realtime/1865398120330647552");

ws.on("open", () => console.log("CONNECTED"));
ws.on("message", (msg) => console.log("DATA:", msg.toString()));
ws.on("error", console.error);
ws.on("close", (code, reason) => console.log("CLOSED", code, reason.toString()));
