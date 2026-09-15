import { SelectField, type SelectOption } from './select';

export const categories = ['CREATE', 'PUBLISH', 'ACCESS', 'DIGITAL'];
export const CATEGORY_OPTIONS: readonly SelectOption[] = [
  { value: 'CREATE', label: 'Create · content you deliver' },
  { value: 'PUBLISH', label: 'Publish · a post on your channel' },
  { value: 'ACCESS', label: 'Access · a live session' },
  { value: 'DIGITAL', label: 'Digital · ready-made files' },
];

export function CategoryField() {
  return <SelectField name="taxonomy" label="What are you offering?" options={CATEGORY_OPTIONS} defaultValue="CREATE" />;
}
