import { marked } from 'marked';

const md = `
- Item
| Header |
| --- |
| Cell |
`;

console.log('--- DEFAULT ---');
console.log(marked.parse(md));
