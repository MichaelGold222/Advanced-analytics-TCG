import { useRef, useState } from 'react'
import { Upload } from 'lucide-react'

interface Props {
  label: string
  hint: string
  onFile: (file: File) => void | Promise<void>
  compact?: boolean
}

export function UploadZone({ label, hint, onFile, compact }: Props) {
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  async function handle(files: FileList | null) {
    const file = files?.[0]
    if (!file) return
    setBusy(true)
    try {
      await onFile(file)
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        void handle(e.dataTransfer.files)
      }}
      className={`rounded-xl border-2 border-dashed text-center transition-colors ${compact ? 'p-4' : 'p-8'}`}
      style={{
        borderColor: dragging ? 'var(--seq-450)' : 'var(--border-strong)',
        background: dragging ? 'var(--surface-2)' : 'transparent',
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
        className="sr-only"
        id={`upload-${label.replace(/\s+/g, '-')}`}
        onChange={(e) => void handle(e.target.files)}
      />
      <Upload className={compact ? 'size-5 mx-auto mb-2' : 'size-7 mx-auto mb-3'} style={{ color: 'var(--text-muted)' }} aria-hidden />
      <label htmlFor={`upload-${label.replace(/\s+/g, '-')}`} className="btn btn-primary cursor-pointer">
        {busy ? 'Reading…' : label}
      </label>
      <p className={`muted mx-auto ${compact ? 'text-xs mt-2 max-w-md' : 'text-sm mt-3 max-w-lg'}`}>{hint}</p>
    </div>
  )
}
