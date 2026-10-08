/** 本机 code serve-web，经网关 /vibe-ide 同源嵌进后台。 */
export function VibePage() {
  return (
    <div className="vibe-page">
      <iframe className="vibe-frame" title="本机 IDE" src="/vibe-ide/" />
    </div>
  );
}
