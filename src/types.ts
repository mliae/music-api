/** 全局绑定与通用响应类型 */

export interface Env {
  DB: D1Database;
  R2: R2Bucket;
  ASSETS: Fetcher;
  /** 站主管理密码（本地 .dev.vars / 线上 wrangler secret）；留空则首次访问后台时设置 */
  ADMIN_PASSWORD: string;
}

export type HonoEnv = { Bindings: Env };

export interface OkResponse<T> {
  code: 200;
  message: string;
  data: T;
}

export interface FailResponse {
  code: number;
  message: string;
  data: null;
}
