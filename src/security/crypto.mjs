import nodeCrypto from "node:crypto";

export const randomUUID = () => nodeCrypto.randomUUID();

/**
 * 规范化 JSON：对象键递归排序，保证同一逻辑内容在任何节点上哈希一致。
 */
export function canonicalJson(value) {
  return JSON.stringify(normalize(value));
}

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, normalize(value[key])]),
    );
  }
  return value;
}

export function sha256Hex(input) {
  return nodeCrypto.createHash("sha256").update(input).digest("hex");
}

export function generateDataKey() {
  return nodeCrypto.randomBytes(32);
}

export function dataKeyFromBase64(encoded) {
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) {
    throw new Error("DESK_DATA_KEY 必须是 base64 编码的 32 字节密钥");
  }
  return key;
}

/**
 * AES-256-GCM 加密，AAD 绑定资源标识，防止密文被搬运到其他记录。
 */
export function sealJson(value, key, aad) {
  const iv = nodeCrypto.randomBytes(12);
  const cipher = nodeCrypto.createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const plaintext = canonicalJson(value);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    alg: "A256GCM",
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

export function openJson(sealed, key, aad) {
  const decipher = nodeCrypto.createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"), {
    authTagLength: 16,
  });
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
  return JSON.parse(plaintext);
}

/**
 * 只校验密文完整性，不返回明文——供无授权的编辑验证链路。
 */
export function verifySealed(sealed, key, aad) {
  try {
    openJson(sealed, key, aad);
    return true;
  } catch {
    return false;
  }
}
