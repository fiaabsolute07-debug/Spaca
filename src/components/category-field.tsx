import { Field } from './ui';

export const categories = ['CREATE', 'PUBLISH', 'ACCESS', 'DIGITAL'];
export function CategoryField() {
  return <Field name="taxonomy" label="What are you offering?">
    <select name="taxonomy">
      {categories.map(c => <option key={c}>
        {c}
      </option>)}
    </select>
  </Field>;
}
