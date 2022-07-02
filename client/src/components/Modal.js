import { useState, useEffect } from "react";

const Modal = (props) => {
  const [newUsername, setNewUsername] = useState('');

  const handleChange = (event) => {
    setNewUsername(event.target.value)
  }

  const handleClick = () => {
    localStorage.setItem("username", newUsername)
    props.setShowModal(false)
  }

  return (
    <div 
      className="modal-main"
      style={{display : props.showModal ? 'block' : 'none'}}
    >
      <div className="modal-header">
       <p>Type your new username</p>
      </div>

      <div className="username-wrapper">
        <input
          className="username-input"
          placeholder="Username..."
          value={newUsername}
          onChange={handleChange}
        />
        <input
          className="username-save-button"
          type="button"
          value="Save"
          onClick={handleClick}
          disabled={!newUsername}
        />
      </div>
    </div>
  )
};

export default Modal;
