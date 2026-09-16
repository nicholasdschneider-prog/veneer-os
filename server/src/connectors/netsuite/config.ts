const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9]+(?:[_-][A-Za-z0-9]+)*$/;

/** Validate the account id before it is used to construct a credential-bearing URL. */
export function normalizeNetSuiteAccountId(value: string): string {
  const accountId = value.trim();
  if (!accountId || accountId.length > 128 || !ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new Error(
      'Invalid NetSuite account ID. Use the account identifier only (for example 1234567 or 1234567_SB1).',
    );
  }
  return accountId;
}

export function netSuiteOriginForAccount(value: string): string {
  const accountId = normalizeNetSuiteAccountId(value);
  const accountDomain = accountId.toLowerCase().replace(/_/g, '-');
  return `https://${accountDomain}.suitetalk.api.netsuite.com`;
}
