import type { ReactNode } from "react";

type InstructionPopupProps = {
  title: string;
  stepLabel: string;
  children: ReactNode;
  onNext: () => void;
  onBack?: () => void;
  overlayClassName?: string;
  nextLabel?: string;
  backLabel?: string;
  nextDisabled?: boolean;
  showBack?: boolean;
};

export default function InstructionPopup({
  title,
  stepLabel,
  children,
  onNext,
  onBack,
  overlayClassName,
  nextLabel = "Next",
  backLabel = "Back",
  nextDisabled = false,
  showBack = true,
}: InstructionPopupProps) {
  return (
    <div
      className={`instruction-overlay ${overlayClassName ?? ""}`}
      role="presentation"
    >
      <section
        aria-labelledby="instruction-popup-title"
        className="instruction-popup"
        role="dialog"
      >
        <div className="instruction-popup-header">
          <span>{stepLabel}</span>
          <h3 id="instruction-popup-title">{title}</h3>
        </div>

        <div className="instruction-popup-body">{children}</div>

        <div className="instruction-popup-actions">
          {showBack && (
            <button
              className="secondary-button"
              disabled={!onBack}
              onClick={onBack}
              type="button"
            >
              {backLabel}
            </button>
          )}
          <button
            className="primary-button"
            disabled={nextDisabled}
            onClick={onNext}
            type="button"
          >
            {nextLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
