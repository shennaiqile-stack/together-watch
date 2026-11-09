/* Personal identity is always read from this device, independent of the room host. */
(() => {
  let sequence=0;
  window.PersonalAccount={user:{logged_in:false},async refresh(){
    const token=++sequence;
    try {
      const response=await fetch('/api/account',{cache:'no-store'}),data=await response.json();
      if(!response.ok||!data.ok)throw new Error('账号状态暂时不可用');
      if(token===sequence){this.user=data.user||{logged_in:false};window.dispatchEvent(new CustomEvent('wt-personal-account',{detail:this.user}));}
    }catch(_){if(token===sequence){this.user={logged_in:false};window.dispatchEvent(new CustomEvent('wt-personal-account',{detail:this.user}));}}
    return this.user;
  }};
})();
