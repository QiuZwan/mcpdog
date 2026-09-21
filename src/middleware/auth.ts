import { Request, Response, NextFunction } from 'express';

/**
 * 判断请求是否指向管理 API。
 *
 * 必须大小写不敏感：Express 的 `app.use('/api', ...)` 按大小写不敏感匹配挂载前缀，
 * 所以 `/API/config` 会被 API 路由正常处理；而中间件若用大小写敏感的
 * `req.path.startsWith('/api/')` 判断，就会把它归入「静态资源」而放行 ——
 * 于是 `GET /API/config` 不带任何令牌即可拿到完整配置（含下游 env 与 apiKey）。
 * 仅监听回环并不构成防线：本机任意进程都可发这个请求。
 */
function isApiPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower === '/api' || lower.startsWith('/api/');
}

// Express-compatible auth middleware
export const createExpressAuthMiddleware = (authToken: string) => {
  return (req: Request, res: Response, next: NextFunction) => {
    // Allow health checks to pass through without auth
    if (req.method === 'GET' && req.path === '/health') {
      return next();
    }

    // Allow login page and login API to pass through without auth
    if (req.path === '/login') {
      return next();
    }

    const authHeader = req.headers.authorization;

    if (!authHeader) {
      // For API requests, return JSON error
      if (isApiPath(req.path)) {
        return res.status(401).json({ error: 'Authorization header is missing' });
      }
      // For static files (HTML, CSS, JS), allow through - auth check will happen in frontend
      if (req.method === 'GET') {
        return next();
      }
      // For other requests, redirect to login
      return res.redirect('/login');
    }

    const parts = authHeader.split(' ');

    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      if (isApiPath(req.path)) {
        return res.status(401).json({ error: 'Authorization header is malformed. Expected: Bearer <token>' });
      }
      // For static files, allow through
      if (req.method === 'GET') {
        return next();
      }
      return res.redirect('/login');
    }

    const token = parts[1];

    // Use a timing-safe comparison to prevent timing attacks
    const isAuthorized = Buffer.compare(Buffer.from(token), Buffer.from(authToken)) === 0;

    if (!isAuthorized) {
      if (isApiPath(req.path)) {
        return res.status(401).json({ error: 'Invalid authentication token' });
      }
      // For static files, allow through
      if (req.method === 'GET') {
        return next();
      }
      return res.redirect('/login');
    }

    next();
  };
};
