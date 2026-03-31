import { App } from "@modelcontextprotocol/ext-apps";

const app = new App(
  { name: "NYC Civic Test", version: "1.0.0" },
  {},
  { autoResize: true }
);

const root = document.getElementById("root")!;
root.innerHTML = `
  <div style="padding: 32px; background: #0a0a0a; color: #e5e5e5; font-family: system-ui; min-height: 400px;">
    <h1 style="font-size: 24px; margin: 0 0 16px;">NYC Civic Dashboard</h1>
    <p id="status" style="color: #888;">Connecting...</p>
    <div style="background: #1a1a1a; padding: 16px; border-radius: 8px; margin-top: 16px;">
      <pre id="data" style="margin: 0; color: #3b82f6; white-space: pre-wrap; font-size: 13px;">Waiting for data...</pre>
    </div>
  </div>
`;

document.body.style.margin = "0";
document.body.style.background = "#0a0a0a";

app.ontoolinput = (params: any) => {
  document.getElementById("status")!.textContent = "Got tool input";
  document.getElementById("data")!.textContent = JSON.stringify(params, null, 2);
};

app.ontoolresult = (result: any) => {
  document.getElementById("status")!.textContent = "Got tool result";
  document.getElementById("data")!.textContent = JSON.stringify(result, null, 2);
};

app.connect().then(() => {
  document.getElementById("status")!.textContent = "Connected!";
  app.sendSizeChanged({ width: 700, height: 400 });
}).catch((err) => {
  document.getElementById("status")!.textContent = "Error: " + err.message;
});
