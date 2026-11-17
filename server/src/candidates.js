'use strict';

/**
 * Candidate roster. Names are spelled exactly as supplied by the poll owner and
 * must not be altered. Image paths map to files in public/img.
 */
const CANDIDATES = [
  {
    id: 'hassan-omar-sarai',
    name: 'Hassan Omar Sarai',
    party: 'UDA',
    photo: 'img/hassan-omar-sarai.jpg',
    logo: 'img/logo-uda.png',
    color: 'var(--p-uda)',
  },
  {
    id: 'abdulswamad-sharif-nasir',
    name: 'Abdulswamad Sharif Nasir',
    party: 'ODM',
    photo: 'img/abdulswamad-sharif-nasir.jpg',
    logo: 'img/logo-odm.jpg',
    color: 'var(--p-odm)',
  },
  {
    id: 'ali-mbogo-menza',
    name: 'Ali Mbogo Menza',
    party: 'Linda Mwananchi Party',
    photo: 'img/ali-mbogo-menza.jpg',
    logo: 'img/logo-linda-mwananchi.png',
    color: 'var(--p-lmp)',
  },
  {
    id: 'suleiman-shabal',
    name: 'Suleiman Shabal',
    party: 'TND',
    photo: 'img/suleiman-shabal.jpg',
    logo: 'img/logo-tnd.jpg',
    color: 'var(--p-tnd)',
  },
  {
    id: 'mohammed-ali-jicho-pevu',
    name: 'Mohammed Ali Jicho Pevu',
    party: 'WIPER',
    photo: 'img/mohammed-ali-jicho-pevu.jpg',
    logo: 'img/logo-wiper.png',
    color: 'var(--p-wiper)',
  },
];

const AGE_BRACKETS = ['Under 18', '18–24', '25–34', '35–44', '45–54', '55–64', '65+'];
const GENDERS = ['Male', 'Female'];
/** The six constituencies of Mombasa County. The poll is Mombasa-only. */
const CONSTITUENCIES = [
  'Changamwe', 'Jomvu', 'Kisauni', 'Likoni', 'Mvita', 'Nyali',
];

const CANDIDATE_IDS = CANDIDATES.map((c) => c.id);
const byId = (id) => CANDIDATES.find((c) => c.id === id) || null;

module.exports = {
  CANDIDATES, CANDIDATE_IDS, AGE_BRACKETS, GENDERS, CONSTITUENCIES, byId,
};
