(function(){
  const toast = (msg) => {
    let el=document.querySelector('.toast');
    if(!el){el=document.createElement('div');el.className='toast';document.body.appendChild(el)}
    el.textContent=msg;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),2200);
  };
  const setButtonLoading = (button, loading, text) => {
    if (!button) return;
    button.disabled = !!loading;
    if (text) button.textContent = text;
    button.classList.toggle('is-loading', !!loading);
  };
  window.KB={toast,setButtonLoading};
})();
