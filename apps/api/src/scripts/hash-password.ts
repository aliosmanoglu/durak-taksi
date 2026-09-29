// Yönetici şifresi için argon2 hash üretir → .env içindeki ADMIN_PASSWORD_HASH.
// Şifre komut satırı argümanı olarak alınmaz (shell geçmişine düşmesin); stdin'den, ekrana yazdırılmadan okunur.
import { createInterface } from 'node:readline';
import { hashPassword } from '../auth/password';

function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    process.stderr.write(prompt);
    // readline yazdığı her şeyi bu metottan geçirir; susturmak girilen karakterlerin görünmesini engeller.
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
    rl.question('', (answer) => {
      rl.close();
      process.stderr.write('\n');
      resolve(answer);
    });
  });
}

const password = await readHidden('Şifre: ');
if (password.length < 12) {
  console.error('Yönetici şifresi en az 12 karakter olmalı.');
  process.exit(1);
}
if ((await readHidden('Tekrar: ')) !== password) {
  console.error('Şifreler eşleşmiyor.');
  process.exit(1);
}
console.log(await hashPassword(password));
