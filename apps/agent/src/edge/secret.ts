const encoder = new TextEncoder();

export const matchesSecret = (
  presented: string | null,
  secret: string | undefined
) => {
  if (presented === null || secret === undefined || secret.length === 0) {
    return false;
  }
  const presentedBytes = encoder.encode(presented);
  const secretBytes = encoder.encode(secret);
  if (presentedBytes.byteLength !== secretBytes.byteLength) {
    crypto.subtle.timingSafeEqual(secretBytes, secretBytes);
    return false;
  }
  return crypto.subtle.timingSafeEqual(presentedBytes, secretBytes);
};

const bearerPrefix = "Bearer ";

export const bearerToken = (request: Request) => {
  const authorization = request.headers.get("Authorization");
  return authorization?.startsWith(bearerPrefix)
    ? authorization.slice(bearerPrefix.length)
    : null;
};
