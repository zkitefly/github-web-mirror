const GITHUB_ORIGIN = "https://github.com";
const HOME_PATH = "/zkitefly/github-web-mirror/blob/main/README.md";
const EXT_PREFIX = "/_ext/";

// 禁用的登录相关入口，按路径首段匹配（/login、/login/oauth/... 等都会被拦截）
const BLOCKED_AUTH_PAGES = [
    "login",
    "logout",
    "session",
    "sessions",
    "signup",
    "signup_check",
    "password_reset",
    "account_verifications",
    "join"
];

// 允许代理的 GitHub 附属域名，同时用于改写页面中的资源地址
const EXT_HOSTS = [
    "github.githubassets.com",
    "opengraph.githubassets.com",
    "avatars.githubusercontent.com",
    "identicons.github.com",
    "camo.githubusercontent.com",
    "user-images.githubusercontent.com",
    "private-user-images.githubusercontent.com",
    "secured-user-images.githubusercontent.com",
    "private-avatars.githubusercontent.com",
    "repository-images.githubusercontent.com",
    "marketplace-screenshots.githubusercontent.com",
    "media.githubusercontent.com",
    "raw.githubusercontent.com",
    "objects.githubusercontent.com",
    "objects-origin.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "viewscreen.githubusercontent.com",
    "codeload.github.com",
    "api.github.com",
    "collector.github.com",
    "www.githubstatus.com",
    "github-cloud.s3.amazonaws.com",
    "github-production-release-asset-2e65be.s3.amazonaws.com",
    "github-production-repository-file-5c1aeb.s3.amazonaws.com",
    "github-production-repository-image-32fea6.s3.amazonaws.com",
    "github-production-upload-manifest-file-7fdce7.s3.amazonaws.com",
    "github-production-user-asset-6210df.s3.amazonaws.com"
].sort((a, b) => b.length - a.length);

// 需要改写响应内容的上游主机
const REWRITE_HOSTS = new Set(["github.com", "github.githubassets.com"]);

// 需要改写正文的响应类型（text/plain 等原始内容保持原样）
const REWRITE_CONTENT_TYPE = /^(?:text\/html|text\/css|application\/(?:x-)?javascript|text\/javascript|application\/json)\b/i;

const EXT_HOST_ALT = EXT_HOSTS.map((host) => host.replace(/\./g, "\\.")).join("|");
const EXT_ABSOLUTE_RE = new RegExp(`https?:\\/\\/(${EXT_HOST_ALT})(?![a-zA-Z0-9.-])`, "gi");
const EXT_PROTOCOL_RE = new RegExp(`\\/\\/(${EXT_HOST_ALT})(?![a-zA-Z0-9.-])`, "gi");
const GITHUB_LINK_RE = /https?:\/\/(?:www\.)?github\.com(\/|(?=[?#"'`\s<>\\),;$+]|$))/gi;

const DROP_REQUEST_HEADERS = [
    "host",
    "content-length",
    "connection",
    "cdn-loop",
    "cf-connecting-ip",
    "cf-ipcountry",
    "cf-ray",
    "cf-visitor",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-real-ip",
    "true-client-ip"
];

const DROP_RESPONSE_HEADERS = [
    "content-security-policy",
    "content-security-policy-report-only",
    "x-frame-options"
];

export default {
    async fetch(request) {
        const url = new URL(request.url);

        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: corsHeaders(new Headers()) });
        }

        // 首页统一跳到仓库页面
        if (url.pathname === "/") {
            return Response.redirect(new URL(HOME_PATH, url).toString(), 302);
        }

        // 登录相关页面直接拒绝
        const firstSegment = url.pathname.split("/")[1].toLowerCase();
        if (BLOCKED_AUTH_PAGES.includes(firstSegment)) {
            return jsonResponse({ code: -1, msg: "login is disabled" }, 403);
        }

        let target;
        try {
            target = resolveTarget(url);
        } catch (err) {
            return jsonResponse({ code: -1, msg: err.message }, 403);
        }

        let response;
        try {
            const rewrite = REWRITE_HOSTS.has(new URL(target).hostname);
            response = await proxy(request, target, rewrite);
        } catch (err) {
            response = jsonResponse({
                code: -1,
                msg: err && err.message ? err.message : String(err)
            }, 502);
        }

        return response;
    }
};

function resolveTarget(url) {
    if (url.pathname.startsWith(EXT_PREFIX)) {
        const rest = url.pathname.slice(EXT_PREFIX.length);
        const index = rest.indexOf("/");
        const host = (index === -1 ? rest : rest.slice(0, index)).toLowerCase();
        if (!EXT_HOSTS.includes(host)) {
            throw new Error("host not allowed: " + host);
        }
        const path = index === -1 ? "/" : rest.slice(index);
        return `https://${host}${path}${url.search}`;
    }

    return GITHUB_ORIGIN + url.pathname + url.search;
}

async function proxy(request, target, rewriteContent) {
    const headers = new Headers(request.headers);
    for (const name of DROP_REQUEST_HEADERS) {
        headers.delete(name);
    }
    // 交给运行时处理压缩，便于读取并改写 HTML
    headers.delete("accept-encoding");

    const init = {
        method: request.method,
        headers,
        redirect: "follow"
    };
    if (!["GET", "HEAD"].includes(request.method)) {
        init.body = request.body;
    }

    const upstream = await fetch(target, init);
    const outHeaders = new Headers(upstream.headers);
    for (const name of DROP_RESPONSE_HEADERS) {
        outHeaders.delete(name);
    }
    corsHeaders(outHeaders);

    const contentType = (upstream.headers.get("content-type") || "").toLowerCase();

    if (rewriteContent && upstream.status === 200 && REWRITE_CONTENT_TYPE.test(contentType)) {
        const body = await upstream.text();
        outHeaders.delete("content-encoding");
        outHeaders.delete("content-length");
        return new Response(rewriteGitHubContent(body, new URL(request.url).origin, contentType.includes("text/html")), {
            status: 200,
            statusText: upstream.statusText,
            headers: outHeaders
        });
    }

    return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: outHeaders
    });
}

// 页面中展示的代码内容（<pre>、<code>）保持原样，避免把把代码块的内容修改
const CODE_BLOCK_RE = /<pre\b[^>]*>[\s\S]*?<\/pre>|<code\b[^>]*>[\s\S]*?<\/code>/gi;

function rewriteGitHubContent(text, origin, isHtml) {
    if (!isHtml) {
        return rewritePlain(text, origin);
    }

    let result = "";
    let last = 0;
    let match;
    CODE_BLOCK_RE.lastIndex = 0;
    while ((match = CODE_BLOCK_RE.exec(text)) !== null) {
        result += rewritePlain(text.slice(last, match.index), origin) + match[0];
        last = match.index + match[0].length;
    }
    return result + rewritePlain(text.slice(last), origin);
}

function rewritePlain(text, origin) {
    // 主站绝对地址改写为本站地址（保留尾部路径）
    text = text.replace(GITHUB_LINK_RE, (match, slash) => origin + (slash || ""));

    // 附属域名的绝对地址改写为 /_ext 代理地址
    text = text.replace(EXT_ABSOLUTE_RE, (match, host) => `${origin}${EXT_PREFIX}${host}`);

    // 协议相对地址（//host/...）同样走代理
    const selfHost = new URL(origin).host;
    return text.replace(EXT_PROTOCOL_RE, (match, host) => `//${selfHost}${EXT_PREFIX}${host}`);
}

function corsHeaders(headers) {
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "*");
    headers.set("Access-Control-Expose-Headers", "*");
    return headers;
}

function jsonResponse(payload, status = 200) {
    const headers = corsHeaders(new Headers({ "Content-Type": "application/json; charset=utf-8" }));
    return new Response(JSON.stringify(payload), { status, headers });
}
