// A small table router for the JSON API. Routes are tried in the order they
// were added; a path that matches a route but not its method answers 405, a
// path no route knows answers the message of a notFound() pattern or is left
// to the caller (404). Patterns are literal paths
// with `:name` (one segment) or `:name(regex)` parameters; the regex must not
// contain parentheses. Parameters are passed raw (not URI-decoded): routes
// decode them with their own 400 message.
//
// A handler gets {req, res, url, query, params, method}. It either answers
// itself (sendJson, a stream, SSE) or returns a value, which is sent as JSON
// with status 200.

import { HttpError, sendJson } from "./http.js";

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];

function compile(pattern) {
  const names = [];
  const src = pattern.replace(/:(\w+)(?:\(([^)]*)\))?|([.+*?^$|[\]{}()\\])/g, (_m, name, re, literal) => {
    if (literal) return `\\${literal}`;
    names.push(name);
    return `(${re || "[^/]+"})`;
  });
  return { re: new RegExp(`^${src}$`), names };
}

export class Router {
  #routes = [];
  #notFound = [];

  /** Add a route: `methods` is a method, a list of them or "*" (any). */
  on(methods, pattern, handler) {
    const list = methods === "*" ? METHODS : [methods].flat();
    this.#routes.push({ methods: list, ...compile(pattern), handler });
    return this;
  }

  /** 404 `message` for unknown paths under `pattern` (e.g. "Chat not found"); only when no route knows the path. */
  notFound(pattern, message) {
    this.#notFound.push({ ...compile(pattern), message });
    return this;
  }

  get(pattern, handler) { return this.on("GET", pattern, handler); }
  post(pattern, handler) { return this.on("POST", pattern, handler); }
  put(pattern, handler) { return this.on("PUT", pattern, handler); }
  patch(pattern, handler) { return this.on("PATCH", pattern, handler); }
  delete(pattern, handler) { return this.on("DELETE", pattern, handler); }

  /** Run the first route matching path and method: true when one ran, false when no route knows the path; 405 for a known path. */
  async handle(req, res, url) {
    let known = false;
    for (const route of this.#routes) {
      const m = route.re.exec(url.pathname);
      if (!m) continue;
      if (!route.methods.includes(req.method)) { known = true; continue; }
      const params = {};
      route.names.forEach((name, i) => { params[name] = m[i + 1]; });
      const out = await route.handler({ req, res, url, query: url.searchParams, params, method: req.method });
      if (out !== undefined && !res.headersSent) sendJson(res, 200, out);
      return true;
    }
    if (known) throw new HttpError(405, "Method not allowed");
    const nf = this.#notFound.find((n) => n.re.test(url.pathname));
    if (nf) throw new HttpError(404, nf.message);
    return false;
  }
}
