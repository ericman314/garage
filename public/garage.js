$(() => {


  $(document).ajaxError((evt, xhr) => {
    if (xhr.status === 401) location.href = '/login.html'
  })

  setInterval(() => {
    $.get('/getDoorState', data => {
      console.log(data)
      $('#doorState').text(data.doorState)

      switch (data.doorState) {
        case 'closed':
          $('body').css('background', 'linear-gradient(0deg, #570000 0%, #8b0000 100%)')
          break
        case 'open':
          $('body').css('background', 'linear-gradient(0deg, #005700 0%, #008b00 100%)')
          break
        case 'moving':
          $('body').css('background', 'linear-gradient(0deg, #574500 0%, #8b6f00 100%)')
          break
        case 'unknown':
          $('body').css('background', 'linear-gradient(0deg, #424242 0%, #535353 100%)')
          break
      }

      switch (data.command) {
        case 'ok':
          $('#command').text('Idle')
          break
        case 'standby':
          $('#command').text('Standing by')
          break
        case 'open':
          $('#command').text('Opening...')
          break
        case 'close':
          $('#command').text('Closing...')
          break
      }
    })
  }, 1000)

  $('#openButton').click(evt => {
    $.get('/command', { command: 'open' })
  })

  $('#closeButton').click(evt => {
    $.get('/command', { command: 'close' })
  })

  $('#logoutButton').click(evt => {
    $.post('/logout').always(() => { location.href = '/login.html' })
  })


})