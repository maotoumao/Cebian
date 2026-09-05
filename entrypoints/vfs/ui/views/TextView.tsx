/** 纯文本（txt / csv / log 等）：限阅读宽度居中、自动换行——这类文件是拿来读的，
 *  不是拿来对行号的。源码类文件走 CodeView。 */
function TextView({ content }: { content: string }) {
  return (
    <div className="max-w-3xl mx-auto px-6 py-6">
      <pre className="text-[13px] leading-relaxed font-mono text-foreground/90 whitespace-pre-wrap wrap-break-word selection:bg-primary/20">
        {content}
      </pre>
    </div>
  );
}

export { TextView };
