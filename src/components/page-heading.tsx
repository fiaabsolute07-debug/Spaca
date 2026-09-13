export function PageHeading({
  eyebrow,
  title,
  description
}: {
  eyebrow: string;
  title: string;
  description?: string;
}) {
  return <div className="page-heading">
    <div className="eyebrow">
      {eyebrow}
    </div>
    <h1>
      {title}
    </h1>
    {description && <p>
      {description}
    </p>}
  </div>;
}
