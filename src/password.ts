import { compare } from "bcryptjs";
import { hashPassword, verifyPassword } from "better-auth/crypto";
// Legacy password hashes are imported only by the offline migration tool.
export const password = {
  hash: hashPassword,
  verify: async ({ hash, password }: { hash: string; password: string }) =>
    /^\$2[aby]\$/.test(hash)
      ? compare(password, hash)
      : verifyPassword({ hash, password }),
};
