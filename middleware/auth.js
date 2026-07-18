


module.exports = {

  ensureAdmin: function (req, res, next) {

    console.log(req.user);
    
    if (req.user.role == 'admin') {
      return next()
    }
    req.flash('error_msg', "invalid request...")
    return res.redirect('/chat')
  }

};