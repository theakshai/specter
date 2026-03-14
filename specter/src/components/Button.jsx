function Button({ label, onClick, className = '' }) {
  return (
    <button
      className={`primary-button ${className}`.trim()}
      type="button"
      onClick={onClick}
    >
      {label}
    </button>
  )
}

export default Button
