import type { AppLanguage } from '../../types';

/** User-facing explanations are localized; provider diagnostics remain verbatim. */
export function modelFailurePresentation(reason: string, message: string, language: AppLanguage, status?: unknown) {
  const zh = language === 'zh';
  const httpStatus = typeof status === 'number' ? status : Number.NaN;
  let detail: string;
  if (/\btool names must be unique\b|\bduplicate tool names?\b|\bconflicting tool definitions\b/i.test(message)) {
    detail = zh ? '工具名称重复，模型服务拒绝了本次请求。已有进度已保留。'
      : 'Duplicate tool names caused the model provider to reject this request. Existing progress is preserved.';
  } else if (['insufficient_quota', 'billing_hard_limit_reached', 'billing_not_active'].includes(reason)) {
    detail = zh ? '模型服务的额度或计费状态不可用，请检查服务商账号。'
      : 'The model provider has no available quota or active billing. Check your provider account.';
  } else if (httpStatus === 401 || reason === 'invalid_api_key') {
    detail = zh ? '模型服务认证失败，请检查账号或 API 密钥。'
      : 'Model provider authentication failed. Check your account or API key.';
  } else if (httpStatus === 403) {
    detail = zh ? '模型服务拒绝访问，请检查账号权限及模型访问权限。'
      : 'The model provider denied access. Check your account and model permissions.';
  } else if (httpStatus === 429 || reason === 'rate_limit_exceeded') {
    detail = zh ? '模型服务暂时限制了请求，请稍后重试。已有进度已保留。'
      : 'The model provider is rate limiting requests. Try again later; existing progress is preserved.';
  } else if (httpStatus === 400 || httpStatus === 422 || reason === 'invalid_request_error') {
    detail = zh ? '模型服务拒绝了请求参数，本轮未能继续。已有进度已保留。'
      : 'The model provider rejected the request parameters. Existing progress is preserved.';
  } else if (httpStatus >= 500 && httpStatus <= 599) {
    detail = zh ? '模型服务暂时异常，请稍后重试。已有进度已保留。'
      : 'The model provider is temporarily unavailable. Try again later; existing progress is preserved.';
  } else {
    detail = zh ? '本轮执行未能完成，已有进度已保留。可展开错误详情查看具体原因。'
      : 'This turn could not finish. Existing progress is preserved; expand the error details for the cause.';
  }
  return {
    title: zh ? '本轮执行失败' : 'This turn failed',
    detail,
    technicalDetails: [reason, message].filter(Boolean).join('\n'),
  };
}
