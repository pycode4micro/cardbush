/** Preserve explicit native launch failures without guessing which policy denied access. */
export function windowsProcessFailure(nativeErrorCode: number | undefined, executable: string) {
  if (nativeErrorCode === 5) return {
    code: 'process_access_denied',
    message: `Windows denied access while preparing or starting ${executable} (error 5). The protected command was not started. Check the account's filesystem permissions and the active sandbox scope; the error alone does not identify which boundary denied access.`,
    blockedExecutable: executable,
  };
  if (![4551, 1260, 577].includes(nativeErrorCode ?? 0)) return undefined;
  const signature = nativeErrorCode === 577;
  return {
    code: signature ? 'process_signature_rejected' : 'process_application_control_blocked',
    message: signature
      ? `Windows 无法验证程序的数字签名，已拒绝启动：${executable}（错误 ${nativeErrorCode}）。请使用发布者提供的可信签名版本；保持 Windows 安全保护开启。 / Windows rejected the executable signature. Use a publisher-provided trusted signed build.`
      : `Windows 应用控制策略已阻止启动：${executable}（错误 ${nativeErrorCode}）。需要发布者提供符合策略的可信版本；这不是内存不足或连接超时。 / Windows Application Control blocked this executable. A publisher-provided policy-compliant build is required.`,
    blockedExecutable: executable,
  };
}
