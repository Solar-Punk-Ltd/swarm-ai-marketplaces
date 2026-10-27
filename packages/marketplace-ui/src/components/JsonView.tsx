import type { ReactNode } from 'react';
import styles from './styles.module.css';

/**
 * Pretty-printed, highlighted JSON(-LD), built from React elements.
 *
 * Never `dangerouslySetInnerHTML`: what this shows is a third-party document (a seller's catalog),
 * and React's escaping is what makes rendering it safe. Formatting matches `JSON.stringify(v, null,
 * 2)`, so a copy of the text is valid JSON.
 *
 * Keys are coloured by kind, which is the point of reading JSON-LD:
 * - `@context`, `@type`, `@id` … — JSON-LD keywords, their own colour;
 * - `swarm-cat:itemCount` — a compact IRI: the prefix dimmed, the term in the key colour;
 * - anything else — a plain key.
 */

const INDENT = '  ';

function Key({ name }: { name: string }) {
  if (name.startsWith('@')) return <span className={styles.jsonKeyword}>"{name}"</span>;
  const colon = name.indexOf(':');
  // A compact IRI has a prefix before the colon, and is not a full URL (`https://…`).
  if (colon > 0 && !name.slice(colon + 1).startsWith('//')) {
    return (
      <span className={styles.jsonKey}>
        "<span className={styles.jsonPrefix}>{name.slice(0, colon + 1)}</span>
        {name.slice(colon + 1)}"
      </span>
    );
  }
  return <span className={styles.jsonKey}>"{name}"</span>;
}

function Scalar({ value }: { value: unknown }) {
  if (typeof value === 'string') {
    return <span className={styles.jsonString}>{JSON.stringify(value)}</span>;
  }
  if (typeof value === 'number') return <span className={styles.jsonNumber}>{String(value)}</span>;
  return <span className={styles.jsonLiteral}>{String(value)}</span>;
}

const punct = (text: string) => <span className={styles.jsonPunct}>{text}</span>;

function render(value: unknown, depth: number): ReactNode {
  const pad = INDENT.repeat(depth + 1);
  const close = INDENT.repeat(depth);

  if (Array.isArray(value)) {
    if (value.length === 0) return punct('[]');
    return (
      <>
        {punct('[')}
        {'\n'}
        {value.map((item, i) => (
          <span key={i}>
            {pad}
            {render(item, depth + 1)}
            {i < value.length - 1 && punct(',')}
            {'\n'}
          </span>
        ))}
        {close}
        {punct(']')}
      </>
    );
  }

  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) return punct('{}');
    return (
      <>
        {punct('{')}
        {'\n'}
        {entries.map(([key, item], i) => (
          <span key={key}>
            {pad}
            <Key name={key} />
            {punct(': ')}
            {render(item, depth + 1)}
            {i < entries.length - 1 && punct(',')}
            {'\n'}
          </span>
        ))}
        {close}
        {punct('}')}
      </>
    );
  }

  return <Scalar value={value} />;
}

export default function JsonView({ value }: { value: unknown }) {
  return <pre className={styles.json}>{render(value, 0)}</pre>;
}
