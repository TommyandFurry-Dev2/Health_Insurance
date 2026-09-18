import crypto from 'node:crypto';

// Payload encryption for NivaBupa's KYC APIs.
//
// Both KYC documents describe "AES/GCM/No Padding" in prose, but the Node and
// .NET sample code they ship uses AES-128-CBC with PKCS7 padding, where the key
// AND the IV are both the first 16 UTF-8 bytes of the configured key string.
// Every sample payload in the documents — including the real server responses
// in their Postman screenshots — decrypts only under the sample-code scheme, and
// NivaBupa UAT answered it live. That is the scheme implemented here.
function keyBytes(secretKey) {
  if (!secretKey) {
    throw new Error('NivaBupa KYC encryption key is not configured (NIVABUPA_KYC_ENCRYPTION_KEY)');
  }
  const key = Buffer.alloc(16);
  Buffer.from(String(secretKey), 'utf8').copy(key, 0, 0, 16);
  return key;
}

function encryptKycPayload(plainText, secretKey) {
  const key = keyBytes(secretKey);
  const cipher = crypto.createCipheriv('aes-128-cbc', key, key);
  return Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]).toString('base64');
}

function decryptKycPayload(cipherText, secretKey) {
  const key = keyBytes(secretKey);
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, key);
  return Buffer.concat([
    decipher.update(Buffer.from(String(cipherText), 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

export { encryptKycPayload, decryptKycPayload };
