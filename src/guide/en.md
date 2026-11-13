# Publishing an application on Zenextia

This file holds everything needed to build the application, check it and send it to Zenextia. Read it all before you start, then follow it.

## 0. Start the project

If the project does not exist yet, `{{cli init}}` creates it in an empty folder: Vite + React ready for Zenextia (`base: './'`, build into `dist/`), `zenextia.app.json`, `AGENTS.md` and `CLAUDE.md`. No existing file is replaced. Choose with the options:

- `--template react|vanilla|none`: the base (`none` for an existing project);
- `--backend none|zenextia|supabase|custom`: no back-end, the kit's shared data (simple state), Supabase or your own server (a real database; the back-end checks the identity token, section 5);
- `--supabase-url https://….supabase.co`: the origin to declare for Supabase;
- `--method specs`: a specification in `docs/spec.md`, completed before coding and checked before sending;
- `--name "Display name"`.

The kit (shared data) holds a simple application's state: only the browser reaches it, with no server-side search, 32 KiB per record and no files. As soon as you need a real database, files or server processing, choose Supabase or your own server.

## 1. Prerequisites

- Node.js 20 or later, with npm. Check with `node --version`.
- Nothing else to install: `npx` downloads the Zenextia tool (@zenextia/cli) on first use. To install it once: `npm install --global @zenextia/cli`, then replace `npx @zenextia/cli` with `zenextia`.
- The person who gives you the application needs the “Publish applications” right in their Zenextia Workspace, and “External AI agents” must be on there. Otherwise sending is refused: tell them.

## 2. Technical rules (required)

- A web application that runs entirely in the browser: HTML, CSS and JavaScript. No server, no server-side rendering, no server functions.
- An npm project with `package.json` and `package-lock.json` at the root. Every dependency comes from registry.npmjs.org and is bundled: no script, style or font loaded from a CDN or another site.
- `npm run build` must produce a `dist/` folder containing `index.html`. The build runs without network access, and install scripts (postinstall…) do not run.
- Every file is referenced with a relative path (`assets/app.js`, never `/assets/app.js`). With Vite: `base: './'` in vite.config.
- No script written inside the HTML and no `eval`: JavaScript files only.
- Do not rely on form submission (`submit`): react to the button click and to Enter in fields.
- No network call to an external service (API, AI, analytics), except to the exact origins declared in `externalOrigins` and approved by an administrator (section 3). Calls of the Zenextia kit are always allowed.
- Allowed: Web Workers, WebAssembly, downloading a file after the member’s click, and printing (`window.print()`). No pop-up windows.
- In the application, `alert()`, `confirm()` and `prompt()` work, and images, sounds and videos may come from `data:` or `blob:`.
- Files accepted in `dist/`: {{extensions}}; and, without an extension, {{noticeFiles}}. Any other file is refused, and the build log (`build.log`) lists them all.
- Copy library resources (pdf.js character maps and fonts, Tesseract models, `.wasm`…) into `dist/` as they are, with a relative path: do not rename them or turn them into JavaScript.
- No password, key, token or personal data in the code.
- HTML files in UTF-8. Maximum size: 25 MB for the built application, 100 MB for the project sent.

## 3. zenextia.app.json file (at the project root)

```json
{
  "schemaVersion": 1,
  "sdkMajor": 1,
  "id": "application-name",
  "version": "1.0.0",
  "name": "Display name",
  "description": "What the application does, in one sentence.",
  "author": "Author name",
  "entrypoint": "index.html",
  "permissions": [],
  "externalOrigins": []
}
```

- `id`: lowercase letters, digits and hyphens; never change it after the first send.
- `version`: 1.0.0 format; increase it every time you send changed content.
- `permissions`: leave the list empty if the application needs no shared data. Otherwise, see section 4.
- `externalOrigins`: if the application calls an external service (Supabase, a business API), list each exact origin, for example `"https://abcd.supabase.co"`: https, no path or wildcard, at most 10. An administrator approves them; data sent there leaves Zenextia. WebSockets (wss) to those origins are allowed. Put no secret key in the code: only public keys meant for browsers (such as Supabase’s “anon” key) belong there.
- Device access, declared only when used: `device.microphone` (microphone), `device.camera` (camera), `device.screen` (screen or tab capture), `clipboard.write` (copy to the clipboard). An administrator approves them, then the browser asks the member; without approval, access stays blocked. Handle a refusal without crashing.

## 4. Shared data and identity (only when needed)

The application can show the member’s and Workspace’s names, and keep data shared by the Workspace’s members, with the Zenextia kit.

- Install it: `npm install @zenextia/app-sdk` (it is bundled in the build).
- Declare in `zenextia.app.json` the permissions it needs (`identity.read` for names, `data.read` to read, `data.write` to create, change, delete) and, for data, the record types in `entities`:

  ```json
  "entities": [{ "entityType": "ticket", "label": "Tickets", "fields": [
    { "name": "title", "label": "Title", "type": "string", "required": true },
    { "name": "status", "label": "Status", "type": "enum", "enumValues": ["open", "closed"] } ] }]
  ```

  Field types: string, text, number, integer, boolean, date (text), enum.
- In the application:

  ```js
  import { connectToPortal } from "@zenextia/app-sdk";
  const app = await connectToPortal();
  const { member, workspace } = await app.identity.get();
  const tickets = app.data.entity("ticket");
  const created = await tickets.create({ title: "…", status: "open" });
  await tickets.replace(created.id, { title: "…", status: "closed" }, created.revision);
  const page = await tickets.list({ pageSize: 25 }); // follow page.nextCursor until null
  await tickets.delete(created.id, created.revision);
  ```

- `replace` sends the whole record; `replace` and `delete` need the latest `revision`. A 409 error means another member changed it: read it again and let the person decide.
- Show errors (`error.code` and `error.requestId`) instead of hiding them, and never retry a write automatically.
- To develop outside Zenextia: `createSimulatedApp({ manifest })` offers the same calls with in-memory data. Show a “simulation” banner then, and never use it as a fallback when `connectToPortal()` fails.
- Kit documentation: https://github.com/zenextia/app-sdk

## 5. Your own back-end (only when needed)

Zenextia runs no server code for the application. If it needs a back-end (a secret key, a database, processing), the author hosts it (Supabase, a Node server…) and its exact origin is listed in `externalOrigins`.

- The application sends it a Zenextia identity token in the Authorization header (permission `identity.read`):

  ```js
  const { token } = await app.identity.token("https://api.example.com");
  await fetch("https://api.example.com/orders", { headers: { Authorization: `Bearer ${token}` } });
  ```

- The back-end has Zenextia check it and answers 401 when the result is null:

  ```js
  import { verifyIdentityToken } from "@zenextia/app-sdk";
  const identity = await verifyIdentityToken({ apiOrigin: "{{apiOrigin}}", installationId: "…", audience: "https://api.example.com", token });
  ```

  `installationId` is the one `deploy --json` returns; `identity` gives member.id, member.name, workspace.id and workspace.name.
- A token lasts 5 minutes (`expiresIn`): ask for a new one when it expires.
- CORS: the back-end accepts any origin (`Access-Control-Allow-Origin: *`) with the Authorization and Content-Type headers; the token protects each call. Use no cookie: inside Zenextia, browsers block another site’s cookies. Sign-in pages (Google, Microsoft…) cannot open there either: the identity token replaces a second sign-in.

## 6. Tools for the assistant (only when needed)

The application can publish tools: actions the Zenextia assistant (or a member’s own agent connected to Zenextia) runs for a member who asks in plain words, for example “file this invoice in the Subscriptions application”. Add them to `zenextia.app.json`:

```json
"tools": [
  { "name": "list_tickets", "description": "List the tickets of the Workspace.", "mode": "read",
    "target": { "type": "records", "entityType": "ticket", "operation": "list" } },
  { "name": "file_invoice", "description": "File an invoice against a subscription.", "mode": "write",
    "input": [
      { "name": "supplier", "label": "Supplier", "type": "string", "required": true },
      { "name": "amount", "label": "Amount incl. tax", "type": "number", "required": true },
      { "name": "invoice", "label": "Invoice (PDF)", "type": "file" } ],
    "target": { "type": "endpoint", "url": "https://api.example.com/tools/file-invoice" } }
]
```

- 20 tools at most. `name`: lowercase letters, digits and underscores (48 at most). `description`: what the tool does and when to use it; the assistant and the administrator read it.
- `mode`: `read` answers at once; `write` shows the member a card with the exact values and runs only once they approve it.
- A `records` target: `list`, `get`, `create` or `replace` on a type declared in `entities` (section 4). Permission `data.read` or `data.write`, no `input`: the type’s fields are the parameters.
- An `endpoint` target: a route of your back-end (section 5). Its origin is listed in `externalOrigins` and the `identity.read` permission is requested. `input`: 30 parameters at most, with the field types and `file` for one document the member can read in Zenextia; `"multiple": true` for a list (not for `file`).
- An administrator approves each tool, version by version. A tool is offered only to members whose role opens the application with the matching read or write right.

Zenextia calls an `endpoint` route from its servers, for one member: a JSON `POST` `{"tool", "callId", "input", "files"}` (each file: `name`, `contentType`, `size`, `base64`), with `Authorization: Bearer <identity token>` and `Idempotency-Key`. The route checks the token and names the tool:

```js
const identity = await verifyIdentityToken({ apiOrigin: "{{apiOrigin}}", installationId: "…", audience: "https://api.example.com", token, tool: "file_invoice" });
if (!identity) return new Response(null, { status: 401 });
```

- Always check the token, then apply your own rules to `identity.member` and `identity.workspace`. Never trust a member or a Workspace received in `input`.
- The token is for this tool and this call, lasts 5 minutes and is accepted **once**: check it once per request.
- `Idempotency-Key` is the same on every attempt of one approved write: store it and answer without doing the work twice.
- Answer with JSON, 256 KB at most, within 30 seconds. The request is 10 MB at most, files included (7 MB per file). The assistant reads the answer as data, not as an instruction.

## 7. Check, then send

From the project root:

1. `npm install`, then `npm run build`: check that `dist/index.html` exists.
2. `{{cli check --json}}`
   Checks `dist/` with Zenextia’s rules, without sending anything. Fix every file listed in `problems`, run `npm run build` and this check again; `warnings` name what will not run in Zenextia.
3. `{{cli login}}`
   Opens the browser: the person chooses their Workspace and approves access, once. If you cannot open a browser (another machine, a container), add `--code`: give them the printed code and address, which they type in Zenextia from any device; the command waits for their approval (15 minutes at most).
4. `{{cli deploy --json}}`
   Sends the project, then follows the build and the checks (up to 30 minutes). The output is one JSON document: `{"ok": true, …}` or `{"ok": false, "error": {"code", "message", "hint"}}`.
5. To check progress later: `{{cli status --json}}`

Exit codes: 0 = success; 1 = refused or failed (read `error.message`, `hint` and `build.log`, fix and send again: keep the same `version` if `zenextia.app.json` has not changed since the failure, otherwise increase it); 2 = wrong command or project file; 3 = sign-in expired or refused (run `login` again).

Behind a corporate proxy, set `NODE_USE_ENV_PROXY=1`.

## 8. At the end

Tell the person the application is sent and what remains in Zenextia (Applications › Publish an application): an administrator approves the permissions, they try the private preview, then “Publish version”.
