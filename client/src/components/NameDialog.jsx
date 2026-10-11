import { useEffect, useRef, useState } from "react";

const MAX_LENGTH = 24

// Asks for a new username, starting from the current one. Mounted only while
// open. Cancel, Escape or a click outside closes it.
const NameDialog = ({username, onSave, onClose}) => {
  const [newUsername, setNewUsername] = useState(username);
  const dialogRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    const dialog = dialogRef.current
    dialog.showModal()
    // typing replaces the old name, the arrow keys keep it
    inputRef.current.select()
    return () => dialog.close()
  }, []);

  const handleSubmit = (event) => {
    event.preventDefault()
    if (newUsername.trim()) onSave(newUsername.trim())
  }

  // the form fills the dialog, so a click on the dialog itself is outside it
  const handleClick = (event) => {
    if (event.target === dialogRef.current) onClose()
  }

  // Escape closes the dialog on its own. Its close event comes a moment
  // after any close, when the dialog may be open again (StrictMode runs the
  // effect twice).
  const handleClose = () => {
    if (!dialogRef.current?.open) onClose()
  }

  return (
    <dialog
      ref={dialogRef}
      className="name-dialog"
      aria-labelledby="name-title"
      onClose={handleClose}
      onClick={handleClick}
    >
      <form className="name-form" onSubmit={handleSubmit}>
        <h2 id="name-title">What should we call you?</h2>
        <div className="name-field">
          <div className="name-field-head">
            <label htmlFor="name">Display name</label>
            <span id="name-count" className="name-count">{newUsername.length} / {MAX_LENGTH}</span>
          </div>
          <input
            ref={inputRef}
            id="name"
            className="field name-input"
            value={newUsername}
            maxLength={MAX_LENGTH}
            aria-describedby="name-count"
            autoComplete="off"
            onChange={(event) => setNewUsername(event.target.value)}
          />
        </div>
        <div className="name-actions">
          <button className="btn btn-2" type="button" onClick={onClose}>Cancel</button>
          <button className="btn" type="submit" disabled={!newUsername.trim()}>Save name</button>
        </div>
      </form>
    </dialog>
  )
};

export default NameDialog;
