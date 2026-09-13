import { CommandForm, Field, str, type Row } from '../ui';
import { mockPaymentsEnabled } from '@/modules/payments/funding';

export function OrderNextStepPanel({
  order: o,
  buyer,
  creator,
  reviews,
  route
}: {
  order: Row;
  buyer: boolean;
  creator: boolean;
  reviews: Row[];
  route: string;
}) {
  return <div className="panel">
    <h2>Next step</h2>
    {str(o.status) === 'AWAITING_PAYMENT' && buyer && mockPaymentsEnabled() && <form
      method="post"
      action="/api/dev/mock-checkout"
      className="command-form"
    >
      <input type="hidden" name="order_id" value={str(o.id)} />
      <p className="muted">
        Local test provider. The order is funded only after the provider's signed
        confirmation is verified. No real funds move.
      </p>
      <button className="button" type="submit">
        Pay with local test provider
        <span aria-hidden>↗</span>
      </button>
    </form>}
    {str(o.status) === 'FUNDED' && creator && <CommandForm
      command="start"
      label="Start work"
      values={{
        order_id: str(o.id)
      }}
      returnTo={route}
    />}
    {" "}
    {str(o.status) === 'DELIVERED' && buyer && <>
      <CommandForm
        command="approve"
        label="Approve delivery"
        values={{
          order_id: str(o.id)
        }}
        returnTo={route}
      />
      <CommandForm
        command="revision"
        label="Request included revision"
        values={{
          order_id: str(o.id)
        }}
        returnTo={route}
      >
        <Field name="body" label="What should change?" type="textarea" required />
      </CommandForm>
      <CommandForm
        command="dispute"
        label="Open a dispute"
        values={{
          order_id: str(o.id)
        }}
        returnTo={route}
      >
        <Field name="body" label="Reason" type="textarea" required />
      </CommandForm>
    </>}
    {str(o.status) === 'REVISION_REQUESTED' && creator && <p>
      Submit the updated delivery above. The order remains in the workspace until the
      buyer approves it.
    </p>}
    {['AWAITING_PAYMENT', 'FUNDED'].includes(str(o.status)) && (buyer || creator) && <CommandForm
      command="cancel"
      label="Cancel order"
      values={{
        order_id: str(o.id)
      }}
      returnTo={route}
    />}
    {" "}
    {['APPROVED', 'COMPLETED'].includes(str(o.status)) && buyer && reviews.length === 0 && <CommandForm
      command="review"
      label="Leave a review"
      values={{
        order_id: str(o.id)
      }}
      returnTo={route}
    >
      <Field name="rating" label="Rating (1–5)" type="number" value="5" required />
      <Field name="body" label="What stood out?" type="textarea" required />
    </CommandForm>}
    {str(o.status) === 'CANCELLED' && str(o.payment_status) === 'REFUND_PENDING' && buyer && <CommandForm
      command="refund"
      label="Check refund with provider"
      values={{
        order_id: str(o.id)
      }}
      returnTo={route}
    >
      <p className="muted">
        A full refund was requested. It shows as refunded only after the provider
        confirms.
      </p>
    </CommandForm>}
    <div className="fee-note">
      All state changes are server-authorized and versioned. The platform fee is 0%;
      any provider cost is tracked separately.
    </div>
  </div>;
}
