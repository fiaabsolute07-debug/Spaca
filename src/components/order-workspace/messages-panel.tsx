import { CommandForm, Field, date, str, type Row } from '../ui';

export function OrderMessagesPanel({
  order: o,
  messages,
  route
}: {
  order: Row;
  messages: Row[];
  route: string;
}) {
  return <div className="panel">
    <h2>Messages</h2>
    {messages.map(message => <div className="record" key={str(message.id)}>
      <strong>
        {str(message.display_name)}
      </strong>
      <p>
        {str(message.body)}
      </p>
      <span className="muted">
        {date(message.created_at)}
      </span>
    </div>)}
    <CommandForm
      command="message"
      label="Send message"
      values={{
        order_id: str(o.id)
      }}
      returnTo={route}
    >
      <Field
        name="body"
        label="Message"
        type="textarea"
        required
        placeholder="Keep project details in this private workspace."
      />
    </CommandForm>
  </div>;
}
