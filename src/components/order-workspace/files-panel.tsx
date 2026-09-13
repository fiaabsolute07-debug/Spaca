import { FileList } from '../files/file-list';
import { FileUploadField } from '../files/file-upload-field';
import { str, type Row } from '../ui';

const BRIEF_STATES = ['AWAITING_PAYMENT', 'FUNDED'];
const DISPUTE_STATES = ['IN_PROGRESS', 'DELIVERED', 'REVISION_REQUESTED', 'DISPUTED'];

/** Brief references (buyer, before work starts) and dispute evidence (both participants); private to the order. */
export function OrderFilesPanel({ order: o, files, buyer }: { order: Row; files: Row[]; buyer: boolean }) {
  const status = str(o.status);
  const briefFiles = files.filter((file) => file.purpose === 'BRIEF');
  const disputeFiles = files.filter((file) => file.purpose === 'DISPUTE');
  const canAddBrief = buyer && BRIEF_STATES.includes(status);
  const canAddEvidence = DISPUTE_STATES.includes(status);
  if (!briefFiles.length && !disputeFiles.length && !canAddBrief && status !== 'DISPUTED') return null;
  return <div className="panel">
    <h2>Order files</h2>
    <h3>Brief references</h3>
    <FileList files={briefFiles} empty="No brief files." />
    {canAddBrief && <FileUploadField purpose="BRIEF" orderId={str(o.id)} label="Add brief files" help="Images, PDF or DOCX. The creator sees them before starting." refreshOnReady />}
    {(disputeFiles.length > 0 || status === 'DISPUTED') && <>
      <h3>Dispute evidence</h3>
      <FileList files={disputeFiles} empty="No evidence files yet." />
    </>}
    {canAddEvidence && status === 'DISPUTED' && <FileUploadField purpose="DISPUTE" orderId={str(o.id)} label="Add evidence" help="Visible to both parties and the support team." refreshOnReady />}
  </div>;
}
