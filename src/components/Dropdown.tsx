import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import './dropdown.css';

type Props<T extends string> = {
  label: string; value: T; options: readonly (readonly [T, string])[]; onChange: (value: T) => void;
};

export default function Dropdown<T extends string>({ label, value, options, onChange }: Props<T>) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const selected = Math.max(0, options.findIndex(([v]) => v === value));
  useEffect(() => {
    if (!open) return;
    list.current?.focus();
    const dismiss = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  const choose = (index: number) => { onChange(options[index][0]); close(); };
  const keys = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); setActive(n => (n + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault(); setActive(e.key === 'Home' ? 0 : options.length - 1);
    } else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(active); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Tab') setOpen(false);
  };
  return <div className="dropdown" ref={root} onBlur={e => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false);
  }}>
    <button ref={trigger} type="button" className="dropdown-trigger" aria-label={`${label}: ${options[selected][1]}`}
      aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => { setActive(selected); setOpen(!open); }}
      onKeyDown={e => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setActive(selected); setOpen(true); } }}>
      <span>{options[selected][1]}</span>
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="m2 4 4 4 4-4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </button>
    {open && <div ref={list} id={id} role="listbox" aria-label={label} tabIndex={0}
      className="dropdown-menu" aria-activedescendant={`${id}-${active}`} onKeyDown={keys}>
      {options.map(([v, text], index) => <div key={v} id={`${id}-${index}`} role="option"
        aria-selected={v === value} className={`dropdown-option${active === index ? ' is-active' : ''}`}
        onPointerMove={() => setActive(index)} onClick={() => choose(index)}>
        <span>{text}</span>{v === value && <span aria-hidden="true">✓</span>}
      </div>)}
    </div>}
  </div>;
}
