import crypto from "node:crypto";

// 规范化 JSON（键排序），用于可复算的哈希承诺。
export function canonical(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
  }
  return value;
}

export const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
export const hashObject = (value) => sha256(canonical(value));

export const randomId = (prefix = "id") => `${prefix}_${crypto.randomBytes(9).toString("base64url")}`;

// 来源内容在客户端加密（AES-256-GCM），服务端只保存密文。
export function encrypt(contentKey, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", contentKey, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    alg: "A256GCM",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

export function decrypt(contentKey, payload) {
  const decipher = crypto.createDecipheriv("aes-256-gcm", contentKey, Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(payload.data, "base64")), decipher.final()]).toString("utf8");
}

export const generateContentKey = () => crypto.randomBytes(32);

// 内容密钥用接收方 RSA 公钥包裹（OAEP），服务端不持有明文密钥，
// 因此即使服务端数据泄露也无法解读未授权的来源内容。
export function wrapKey(publicKeyPem, contentKey) {
  return crypto
    .publicEncrypt(
      { key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      contentKey,
    )
    .toString("base64");
}

export function unwrapKey(privateKeyPem, wrapped) {
  return crypto.privateDecrypt(
    { key: privateKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(wrapped, "base64"),
  );
}

export const generateKeyPair = () =>
  crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
