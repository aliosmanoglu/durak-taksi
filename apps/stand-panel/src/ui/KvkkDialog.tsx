import { KVKK_DRAFT_LABEL, KVKK_NOTICE_PARAGRAPHS, KVKK_NOTICE_TITLE, KVKK_NOTICE_VERSION } from '../lib/kvkk';
import { TA } from '../lib/texts-admin';
import { Button, Dialog } from './kit';

/** KVKK aydınlatma metni (taslak; kaynak: docs/legal/kvkk-aydinlatma-taslak.md). */
export function KvkkDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title={`${KVKK_NOTICE_TITLE} (${KVKK_DRAFT_LABEL})`} onClose={onClose}>
      <div className="max-h-[60vh] space-y-3 overflow-y-auto text-lg">
        {KVKK_NOTICE_PARAGRAPHS.map((p, i) => (
          <p key={i}>{p}</p>
        ))}
        <p className="text-sm text-slate-600 dark:text-slate-300">Sürüm: {KVKK_NOTICE_VERSION}</p>
      </div>
      <Button variant="primary" className="mt-4 w-full" onClick={onClose} data-autofocus>
        {TA.register.kvkkClose}
      </Button>
    </Dialog>
  );
}
