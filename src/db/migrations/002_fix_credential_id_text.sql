-- Earlier code stored credentials.credential_id as a Buffer of UTF-8 bytes
-- (Buffer.from(string) without second arg). @simplewebauthn v11 expects
-- credential ids as plain base64url strings. Convert any existing BLOB rows
-- to TEXT — the bytes happen to be valid UTF-8 of a base64url string already.

UPDATE credentials
   SET credential_id = CAST(credential_id AS TEXT)
 WHERE typeof(credential_id) = 'blob';
