import { hash, verify } from '@node-rs/argon2';

// OWASP önerisi (argon2id, 19 MiB, t=2, p=1).
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (password: string) => hash(password, OPTIONS);

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

// Kullanıcı bulunamadığında da aynı maliyette doğrulama yapılır (kullanıcı adı tahminine karşı zamanlama farkı olmasın).
let dummyHash: Promise<string> | undefined;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword('zamanlama-esitleme-icin-sahte-sifre');
  await verifyPassword(await dummyHash, password);
}
